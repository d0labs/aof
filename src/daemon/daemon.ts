import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { TaskStore } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import { AOFService, type AOFServiceConfig } from "../service/aof-service.js";
import type { AOFMetrics } from "../metrics/exporter.js";
import type { poll } from "../dispatch/scheduler.js";
import { createHealthServer, type DaemonStateProvider } from "./server.js";

export interface AOFDaemonOptions extends AOFServiceConfig {
  store?: TaskStore;
  logger?: EventLogger;
  metrics?: AOFMetrics;
  poller?: typeof poll;
  healthPort?: number;
  healthBind?: string;
  enableHealthServer?: boolean;
}

export interface AOFDaemonContext {
  service: AOFService;
  healthServer?: Server;
}

const startTime = Date.now();

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 checks existence
    return true;
  } catch {
    return false;
  }
}

export async function startAofDaemon(opts: AOFDaemonOptions): Promise<AOFDaemonContext> {
  const store = opts.store ?? new TaskStore(opts.dataDir);
  const logger = opts.logger ?? new EventLogger(join(opts.dataDir, "events"));

  const service = new AOFService(
    {
      store,
      logger,
      metrics: opts.metrics,
      poller: opts.poller,
    },
    {
      dataDir: opts.dataDir,
      dryRun: opts.dryRun,
      pollIntervalMs: opts.pollIntervalMs,
      defaultLeaseTtlMs: opts.defaultLeaseTtlMs,
    },
  );

  // PID file locking to prevent multiple daemon instances
  const lockFile = join(opts.dataDir, "daemon.pid");

  // Check for existing daemon
  if (existsSync(lockFile)) {
    const pidStr = readFileSync(lockFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);

    if (!isNaN(pid) && isProcessRunning(pid)) {
      throw new Error(`AOF daemon already running (PID: ${pid})`);
    } else {
      // Stale PID file, clean up
      unlinkSync(lockFile);
    }
  }

  // Write our PID
  writeFileSync(lockFile, String(process.pid));

  // Cleanup on exit
  process.on("exit", () => {
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
  });

  // Handle SIGTERM/SIGINT
  process.on("SIGTERM", () => {
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
    process.exit(0);
  });

  process.on("SIGINT", () => {
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
    process.exit(0);
  });

  await service.start();

  // Start health server if enabled
  let healthServer: Server | undefined;
  if (opts.enableHealthServer ?? true) {
    const getState: DaemonStateProvider = () => {
      const status = service.getStatus();
      return {
        lastPollAt: status.lastPollAt ? new Date(status.lastPollAt).getTime() : Date.now(),
        lastEventAt: Date.now(), // TODO: track from EventLogger
        uptime: Date.now() - startTime,
      };
    };

    healthServer = createHealthServer(
      getState, 
      store, 
      opts.healthPort ?? 3000, 
      opts.healthBind ?? "127.0.0.1"
    );
  }

  return { service, healthServer };
}
