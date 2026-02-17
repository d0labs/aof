import { createRestartTracker, type RestartRecord } from "./restart-tracker.js";
import { formatAlert, type OpsAlert } from "./alerting.js";
import type { HealthStatus } from "../../daemon/health.js";

export interface WatchdogConfig {
  enabled: boolean;
  pollIntervalMs: number;
  healthEndpoint: string;
  maxRestarts: number;
  windowMs: number;
  onAlert?: (alert: OpsAlert) => void | Promise<void>;
  onRestart?: (reason: string) => void | Promise<void>;
}

export interface Watchdog {
  stop(): Promise<void>;
}

export async function startWatchdog(config: WatchdogConfig): Promise<Watchdog | undefined> {
  if (!config.enabled) {
    return undefined;
  }

  const tracker = createRestartTracker({
    maxRestarts: config.maxRestarts,
    windowMs: config.windowMs,
  });

  let running = true;
  let pollTimer: NodeJS.Timeout | undefined;

  async function checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(config.healthEndpoint);
      return response.status === 200;
    } catch (err) {
      console.error("[Watchdog] Health check failed:", (err as Error).message);
      return false;
    }
  }

  async function getHealthStatus(): Promise<HealthStatus | null> {
    try {
      const response = await fetch(config.healthEndpoint);
      if (response.ok) {
        return await response.json() as HealthStatus;
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  async function restartDaemon(): Promise<void> {
    console.log("[Watchdog] Restarting daemon...");
    
    // Notify restart callback if provided
    if (config.onRestart) {
      await config.onRestart("health check failed");
    }

    // In real implementation, this would:
    // 1. Kill existing daemon process
    // 2. Run: aof-daemon start (via child_process.spawn)
    // 3. Wait for /health to return 200

    // For now, just log (actual restart logic would be environment-specific)
    console.log("[Watchdog] Daemon restart triggered");
  }

  async function alertOpsTeam(restarts: RestartRecord[]): Promise<void> {
    const health = await getHealthStatus();
    const fallbackHealth: HealthStatus = {
      status: "unhealthy",
      uptime: 0,
      lastPollAt: 0,
      lastEventAt: 0,
      taskCounts: {
        open: 0,
        ready: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      },
    };

    const alert = formatAlert(restarts, health ?? fallbackHealth);

    console.error("[Watchdog] Max restarts exceeded, alerting ops team");
    console.error(alert.body);

    if (config.onAlert) {
      await config.onAlert(alert);
    }
  }

  async function watchdogLoop(): Promise<void> {
    if (!running) return;

    const healthy = await checkHealth();

    if (!healthy) {
      if (tracker.canRestart()) {
        tracker.recordRestart("health check failed");
        await restartDaemon();
      } else {
        // Max restarts exceeded
        await alertOpsTeam(tracker.getHistory());
        running = false;
        return;
      }
    }

    // Schedule next poll
    if (running) {
      pollTimer = setTimeout(() => {
        void watchdogLoop();
      }, config.pollIntervalMs);
    }
  }

  // Start the watchdog loop
  void watchdogLoop();

  return {
    async stop(): Promise<void> {
      running = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    },
  };
}
