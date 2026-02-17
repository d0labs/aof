#!/usr/bin/env node

import { resolve } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { startAofDaemon } from "./daemon.js";

const AOF_ROOT = process.env["AOF_ROOT"] ?? resolve(homedir(), "Projects", "AOF");

const program = new Command()
  .name("aof-daemon")
  .description("AOF scheduler daemon (poll-only)")
  .option("--root <path>", "AOF root directory", AOF_ROOT)
  .option("--interval <ms>", "Poll interval in ms", "30000")
  .option("--active", "Active mode (mutate state)", false);

program.action(async (opts: { root: string; interval: string; active: boolean }) => {
  const pollIntervalMs = Number(opts.interval);
  if (Number.isNaN(pollIntervalMs) || pollIntervalMs <= 0) {
    console.error("Invalid --interval (must be positive number)");
    process.exitCode = 1;
    return;
  }

  // Read port and bind from environment (set by CLI fork)
  const healthPort = process.env["AOF_DAEMON_PORT"] 
    ? parseInt(process.env["AOF_DAEMON_PORT"], 10) 
    : 18000;
  const healthBind = process.env["AOF_DAEMON_BIND"] ?? "127.0.0.1";

  const { service, healthServer } = await startAofDaemon({
    dataDir: opts.root,
    pollIntervalMs,
    dryRun: !opts.active,
    enableHealthServer: true,
    healthPort,
    healthBind,
  });

  console.log(`[AOF] Daemon started. Health endpoint: http://${healthBind}:${healthPort}/health`);

  const shutdown = async () => {
    if (healthServer) {
      await new Promise<void>((resolve) => {
        healthServer.close(() => resolve());
      });
    }
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
