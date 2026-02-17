/**
 * Daemon management commands — start/stop/status/restart.
 * 
 * Implements daemon lifecycle management via CLI.
 */

import { fork, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DaemonStartOptions {
  port: string;
  bind: string;
  dataDir?: string;
  logLevel: string;
}

export interface DaemonStopOptions {
  timeout: string;
}

/**
 * Check if a process is running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 checks existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Read PID from daemon.pid file.
 */
function readPidFile(dataDir: string): number | null {
  const pidFile = join(dataDir, "daemon.pid");
  if (!existsSync(pidFile)) {
    return null;
  }
  const pidStr = readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(pidStr, 10);
  return isNaN(pid) ? null : pid;
}

/**
 * Clean up stale PID file.
 */
function cleanupStalePidFile(dataDir: string): void {
  const pidFile = join(dataDir, "daemon.pid");
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
    console.log("   Cleaned up stale PID file");
  }
}

/**
 * Get daemon uptime from PID.
 */
async function getDaemonUptime(pid: number): Promise<number | null> {
  try {
    // Use ps to get process start time
    const { execSync } = await import("node:child_process");
    const output = execSync(`ps -p ${pid} -o etime=`, { encoding: "utf-8" }) as string;
    const etime = output.trim();
    
    // Parse etime format: [[dd-]hh:]mm:ss
    const parts = etime.split(/[-:]/);
    let seconds = 0;
    
    if (parts.length === 1 && parts[0]) {
      // ss
      seconds = parseInt(parts[0], 10);
    } else if (parts.length === 2 && parts[0] && parts[1]) {
      // mm:ss
      seconds = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    } else if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
      // hh:mm:ss
      seconds = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    } else if (parts.length === 4 && parts[0] && parts[1] && parts[2] && parts[3]) {
      // dd-hh:mm:ss
      seconds = parseInt(parts[0], 10) * 86400 + parseInt(parts[1], 10) * 3600 + parseInt(parts[2], 10) * 60 + parseInt(parts[3], 10);
    }
    
    return seconds;
  } catch {
    return null;
  }
}

/**
 * Format uptime in human-readable format.
 */
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

/**
 * Start the daemon in background.
 */
export async function daemonStart(
  dataDir: string,
  options: DaemonStartOptions
): Promise<void> {
  // Check if daemon is already running
  const existingPid = readPidFile(dataDir);
  if (existingPid && isProcessRunning(existingPid)) {
    console.error(`❌ Daemon already running (PID: ${existingPid})`);
    process.exitCode = 1;
    return;
  }

  // Clean up stale PID file if exists
  if (existingPid && !isProcessRunning(existingPid)) {
    cleanupStalePidFile(dataDir);
  }

  // Resolve daemon entry point
  const daemonEntry = join(__dirname, "../../daemon/index.js");
  
  console.log("🚀 Starting AOF daemon...\n");
  console.log(`   Data directory: ${dataDir}`);
  console.log(`   Port: ${options.port}`);
  console.log(`   Bind address: ${options.bind}`);
  console.log(`   Log level: ${options.logLevel}\n`);

  // Fork daemon process (detached)
  const child: ChildProcess = fork(daemonEntry, [
    "--root", dataDir,
  ], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AOF_DAEMON_PORT: options.port,
      AOF_DAEMON_BIND: options.bind,
      AOF_LOG_LEVEL: options.logLevel,
    },
  });

  child.unref();

  // Wait a bit to check if daemon started successfully
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const pid = readPidFile(dataDir);
  if (!pid || !isProcessRunning(pid)) {
    console.error("❌ Daemon failed to start");
    console.error("   Check daemon logs for details");
    process.exitCode = 1;
    return;
  }

  console.log(`✅ Daemon started successfully`);
  console.log(`   PID: ${pid}`);
  console.log(`   Health endpoint: http://${options.bind}:${options.port}/health`);
}

/**
 * Stop the daemon.
 */
export async function daemonStop(
  dataDir: string,
  options: DaemonStopOptions
): Promise<void> {
  const pid = readPidFile(dataDir);
  
  if (!pid) {
    console.log("ℹ️  Daemon not running (no PID file)");
    return;
  }

  if (!isProcessRunning(pid)) {
    console.log("ℹ️  Daemon not running (process not found)");
    cleanupStalePidFile(dataDir);
    return;
  }

  const timeoutSeconds = parseInt(options.timeout, 10);
  console.log(`🛑 Stopping daemon (PID: ${pid})...\n`);

  // Send SIGTERM for graceful shutdown
  try {
    process.kill(pid, "SIGTERM");
    console.log("   Sent SIGTERM, waiting for graceful shutdown...");
  } catch (err) {
    console.error(`❌ Failed to send SIGTERM: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // Wait for graceful shutdown
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutSeconds * 1000) {
    if (!isProcessRunning(pid)) {
      console.log("   Daemon stopped gracefully");
      cleanupStalePidFile(dataDir);
      console.log("\n✅ Daemon stopped");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Force kill if still alive
  console.log(`   Timeout (${timeoutSeconds}s) reached, sending SIGKILL...`);
  try {
    process.kill(pid, "SIGKILL");
    console.log("   Daemon force-killed");
  } catch (err) {
    console.error(`❌ Failed to force-kill: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  cleanupStalePidFile(dataDir);
  console.log("\n✅ Daemon stopped (force-killed)");
}

/**
 * Check daemon status.
 */
export async function daemonStatus(
  dataDir: string,
  healthPort: string,
  healthBind: string
): Promise<void> {
  const pid = readPidFile(dataDir);

  if (!pid) {
    console.log("❌ Daemon not running (no PID file)");
    process.exitCode = 1;
    return;
  }

  if (!isProcessRunning(pid)) {
    console.log("❌ Daemon not running (stale PID file)");
    console.log(`   Stale PID: ${pid}`);
    console.log(`   PID file: ${join(dataDir, "daemon.pid")}`);
    process.exitCode = 1;
    return;
  }

  // Daemon is running
  const uptime = await getDaemonUptime(pid);
  
  console.log("✅ Daemon running\n");
  console.log(`   PID: ${pid}`);
  if (uptime !== null) {
    console.log(`   Uptime: ${formatUptime(uptime)}`);
  }
  console.log(`   Health endpoint: http://${healthBind}:${healthPort}/health`);
  console.log(`   Data directory: ${dataDir}`);
}

/**
 * Restart the daemon.
 */
export async function daemonRestart(
  dataDir: string,
  startOptions: DaemonStartOptions
): Promise<void> {
  console.log("🔄 Restarting daemon...\n");

  // Stop first
  const stopOptions: DaemonStopOptions = { timeout: "10" };
  await daemonStop(dataDir, stopOptions);

  // Wait a bit before starting
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Start
  console.log("");
  await daemonStart(dataDir, startOptions);
}
