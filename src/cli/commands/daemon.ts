/**
 * Daemon management commands -- install/uninstall/start/stop/status.
 *
 * `install`   writes an OS service file (launchd plist / systemd unit) and starts the daemon.
 * `uninstall` stops the daemon, removes the service file, and cleans up.
 * `start`     redirects to `install`, or runs in foreground with --foreground.
 * `stop`      sends SIGTERM via PID, with timeout fallback to SIGKILL.
 * `status`    reads PID file and reports daemon state (redesign planned for Plan 03).
 */

import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import type { Command } from "commander";
import {
  installService,
  uninstallService,
  getServiceFilePath,
  type ServiceFileConfig,
} from "../../daemon/service-file.js";
import { selfCheck } from "../../daemon/server.js";
import { startAofDaemon } from "../../daemon/daemon.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export interface DaemonStopOptions {
  timeout: string;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(dataDir: string): number | null {
  const pidFile = join(dataDir, "daemon.pid");
  if (!existsSync(pidFile)) return null;
  const pidStr = readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(pidStr, 10);
  return isNaN(pid) ? null : pid;
}

function cleanupStalePidFile(dataDir: string): void {
  const pidFile = join(dataDir, "daemon.pid");
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
    console.log("   Cleaned up stale PID file");
  }
}

async function getDaemonUptime(pid: number): Promise<number | null> {
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(`ps -p ${pid} -o etime=`, { encoding: "utf-8" }) as string;
    const etime = output.trim();
    const parts = etime.split(/[-:]/);
    let seconds = 0;
    if (parts.length === 1 && parts[0]) {
      seconds = parseInt(parts[0], 10);
    } else if (parts.length === 2 && parts[0] && parts[1]) {
      seconds = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    } else if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
      seconds = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    } else if (parts.length === 4 && parts[0] && parts[1] && parts[2] && parts[3]) {
      seconds = parseInt(parts[0], 10) * 86400 + parseInt(parts[1], 10) * 3600 + parseInt(parts[2], 10) * 60 + parseInt(parts[3], 10);
    }
    return seconds;
  } catch {
    return null;
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate that the data directory is usable for daemon operation.
 * Checks existence, writability (via logs dir creation), and basic structure.
 */
function validateConfig(dataDir: string): { valid: boolean; error?: string } {
  if (!existsSync(dataDir)) {
    return { valid: false, error: `Data directory does not exist: ${dataDir}` };
  }

  // Ensure tasks/ directory exists or can be created
  const tasksDir = join(dataDir, "tasks");
  try {
    mkdirSync(tasksDir, { recursive: true });
  } catch (err) {
    return {
      valid: false,
      error: `Cannot create tasks directory at ${tasksDir}: ${(err as Error).message}`,
    };
  }

  // Ensure logs/ directory exists or can be created
  const logsDir = join(dataDir, "logs");
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    return {
      valid: false,
      error: `Cannot create logs directory at ${logsDir}: ${(err as Error).message}`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async function daemonInstall(dataDir: string): Promise<void> {
  console.log("Installing AOF daemon...\n");

  // Validate config
  const validation = validateConfig(dataDir);
  if (!validation.valid) {
    console.error(`Error: ${validation.error}`);
    console.error("\nFix the issue above and try again.");
    process.exitCode = 1;
    return;
  }

  const platformName = process.platform === "darwin" ? "macOS (launchd)" : "Linux (systemd)";
  const servicePath = getServiceFilePath(process.platform);
  const socketPath = join(dataDir, "daemon.sock");

  const config: ServiceFileConfig = { dataDir };

  try {
    const result = await installService(config);

    console.log(`  Platform:       ${platformName}`);
    console.log(`  Service file:   ${result.servicePath}`);
    console.log(`  Data directory: ${dataDir}`);
    console.log(`  Socket:         ${socketPath}`);
    console.log("");

    // Wait 2 seconds for daemon to start, then health check
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const healthy = await selfCheck(socketPath);
    if (healthy) {
      const pid = readPidFile(dataDir);
      console.log(`Daemon installed and started.${pid ? ` (PID: ${pid})` : ""}`);
    } else {
      console.log("Service file installed but daemon may not have started yet.");
      console.log("Check `aof daemon status`.");
    }
  } catch (err) {
    console.error(`Failed to install daemon: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

async function daemonUninstall(dataDir: string): Promise<void> {
  try {
    await uninstallService(dataDir);
    console.log("Daemon uninstalled. Service file removed.");
  } catch (err) {
    console.error(`Failed to uninstall daemon: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Start (foreground mode for development)
// ---------------------------------------------------------------------------

async function daemonStartForeground(dataDir: string): Promise<void> {
  console.log("Starting AOF daemon in foreground...\n");

  const validation = validateConfig(dataDir);
  if (!validation.valid) {
    console.error(`Error: ${validation.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`  Data directory: ${dataDir}`);
  console.log(`  Socket:         ${join(dataDir, "daemon.sock")}`);
  console.log("");

  try {
    const { service } = await startAofDaemon({
      dataDir,
      enableHealthServer: true,
    });

    console.log("Daemon running. Press Ctrl+C to stop.");

    // Keep the process alive — signal handlers in daemon.ts handle shutdown
    await new Promise<void>(() => {
      // Never resolves — the daemon runs until killed
    });
  } catch (err) {
    console.error(`Failed to start daemon: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export async function daemonStop(
  dataDir: string,
  options: DaemonStopOptions,
): Promise<void> {
  const pid = readPidFile(dataDir);

  if (!pid) {
    console.log("Daemon is not running. Run `aof daemon install` to start.");
    return;
  }

  if (!isProcessRunning(pid)) {
    console.log("Daemon is not running (stale PID file).");
    cleanupStalePidFile(dataDir);
    return;
  }

  const timeoutSeconds = parseInt(options.timeout, 10);
  console.log(`Stopping daemon (PID: ${pid})...\n`);

  try {
    process.kill(pid, "SIGTERM");
    console.log("   Sent SIGTERM, waiting for graceful shutdown...");
  } catch (err) {
    console.error(`Failed to send SIGTERM: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutSeconds * 1000) {
    if (!isProcessRunning(pid)) {
      console.log("   Daemon stopped gracefully");
      cleanupStalePidFile(dataDir);
      console.log("\nDaemon stopped.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`   Timeout (${timeoutSeconds}s) reached, sending SIGKILL...`);
  try {
    process.kill(pid, "SIGKILL");
    console.log("   Daemon force-killed");
  } catch (err) {
    console.error(`Failed to force-kill: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  cleanupStalePidFile(dataDir);
  console.log("\nDaemon stopped (force-killed).");
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function daemonStatus(dataDir: string): Promise<void> {
  const pid = readPidFile(dataDir);
  const socketPath = join(dataDir, "daemon.sock");

  if (!pid) {
    console.log("Daemon is not running. Run `aof daemon install` to start.");
    process.exitCode = 2;
    return;
  }

  if (!isProcessRunning(pid)) {
    console.log("Daemon is not running (stale PID file).");
    console.log(`   Stale PID: ${pid}`);
    console.log(`   PID file:  ${join(dataDir, "daemon.pid")}`);
    process.exitCode = 2;
    return;
  }

  const uptime = await getDaemonUptime(pid);
  const healthy = await selfCheck(socketPath);

  console.log("Daemon running\n");
  console.log(`   PID:          ${pid}`);
  if (uptime !== null) {
    console.log(`   Uptime:       ${formatUptime(uptime)}`);
  }
  console.log(`   Health:       ${healthy ? "ok" : "unreachable"}`);
  console.log(`   Socket:       ${socketPath}`);
  console.log(`   Data dir:     ${dataDir}`);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Daemon lifecycle management (install, uninstall, stop, status)");

  daemon
    .command("install")
    .description("Install and start the AOF daemon under OS supervision (launchd/systemd)")
    .option("--data-dir <path>", "Data directory (default: --root value)")
    .action(async (opts: { dataDir?: string }) => {
      const root = program.opts()["root"] as string;
      const dataDir = opts.dataDir ?? root;
      await daemonInstall(dataDir);
    });

  daemon
    .command("uninstall")
    .description("Stop the daemon, remove the service file, and clean up")
    .option("--data-dir <path>", "Data directory (default: --root value)")
    .action(async (opts: { dataDir?: string }) => {
      const root = program.opts()["root"] as string;
      const dataDir = opts.dataDir ?? root;
      await daemonUninstall(dataDir);
    });

  daemon
    .command("start")
    .description("Start daemon (use --foreground for development, otherwise redirects to install)")
    .option("--foreground", "Run daemon in the current process (development mode)", false)
    .option("--data-dir <path>", "Data directory (default: --root value)")
    .action(async (opts: { foreground: boolean; dataDir?: string }) => {
      const root = program.opts()["root"] as string;
      const dataDir = opts.dataDir ?? root;

      if (opts.foreground) {
        await daemonStartForeground(dataDir);
      } else {
        console.log("Use `aof daemon install` to start the daemon under OS supervision.");
        console.log("Use `aof daemon start --foreground` for development.\n");
        await daemonInstall(dataDir);
      }
    });

  daemon
    .command("stop")
    .description("Stop the running daemon")
    .option("--timeout <seconds>", "Shutdown timeout in seconds", "10")
    .action(async (opts: { timeout: string }) => {
      const root = program.opts()["root"] as string;
      await daemonStop(root, opts);
    });

  daemon
    .command("status")
    .description("Check daemon status")
    .action(async () => {
      const root = program.opts()["root"] as string;
      await daemonStatus(root);
    });
}
