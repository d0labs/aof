/**
 * AOF Self-Update Engine
 * Handles downloading, extracting, validating, and installing new versions.
 */

import { readFile, writeFile, mkdir, rm, cp, access, readdir as _readdir, mkdtemp as _mkdtemp } from "node:fs/promises";
import { join, dirname as _dirname } from "node:path";
import { tmpdir } from "node:os";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execSync } from "node:child_process";

export interface UpdateHooks {
  preUpdate?: (ctx: {
    currentVersion: string;
    targetVersion: string;
    aofRoot: string;
  }) => Promise<void>;
  postUpdate?: (ctx: {
    previousVersion: string;
    currentVersion: string;
    aofRoot: string;
  }) => Promise<void>;
}

export interface UpdateOptions {
  aofRoot: string;
  targetVersion: string;
  downloadUrl: string;
  preservePaths?: string[];
  healthCheck?: (aofRoot: string) => Promise<boolean>;
  hooks?: UpdateHooks;
  timeoutMs?: number;
}

export interface UpdateResult {
  success: boolean;
  version: string;
  backupCreated: boolean;
  backupPath?: string;
}

export interface RollbackOptions {
  aofRoot: string;
  backupPath: string;
  preservePaths?: string[];
}

export interface RollbackResult {
  success: boolean;
  restoredVersion: string;
}

const BACKUP_DIR_NAME = ".aof-backup";

/**
 * Perform self-update to a new version.
 */
export async function selfUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const {
    aofRoot,
    targetVersion,
    downloadUrl,
    preservePaths = ["config", "data", "tasks", "events"],
    healthCheck,
    hooks,
    timeoutMs = 30000,
  } = opts;

  let backupPath: string | undefined;
  let tempDir: string | undefined;

  try {
    // Get current version
    const currentVersion = await getCurrentVersion(aofRoot);

    // Execute pre-update hook
    if (hooks?.preUpdate) {
      await hooks.preUpdate({ currentVersion, targetVersion, aofRoot });
    }

    // Create backup
    backupPath = await createBackup(aofRoot, preservePaths);

    // Download tarball
    tempDir = await mkdtemp(join(tmpdir(), "aof-update-"));
    const tarballPath = join(tempDir, "aof.tar.gz");

    await downloadFile(downloadUrl, tarballPath, timeoutMs);

    // Extract to temp location
    const extractDir = join(tempDir, "extracted");
    await mkdir(extractDir, { recursive: true });
    await extractTarball(tarballPath, extractDir);

    // Validate with health check
    if (healthCheck) {
      const valid = await healthCheck(extractDir);
      if (!valid) {
        throw new Error("Health check failed on downloaded version");
      }
    }

    // Atomic swap: move old → backup, move new → current
    // Preserve specified paths by copying them to temp first
    const preservedPaths: Map<string, string> = new Map();
    const preserveTempDir = join(tempDir, "preserved");
    await mkdir(preserveTempDir, { recursive: true });

    for (const path of preservePaths) {
      const sourcePath = join(aofRoot, path);
      const tempPath = join(preserveTempDir, path);
      try {
        await access(sourcePath);
        await cp(sourcePath, tempPath, { recursive: true });
        preservedPaths.set(path, tempPath);
      } catch {
        // Path doesn't exist, skip
      }
    }

    // Remove old installation (except backup)
    const entries = await readdir(aofRoot);
    for (const entry of entries) {
      if (entry === BACKUP_DIR_NAME) continue;
      await rm(join(aofRoot, entry), { recursive: true, force: true });
    }

    // Copy new version
    await cp(extractDir, aofRoot, { recursive: true });

    // Restore preserved paths
    for (const [path, tempPath] of preservedPaths) {
      const targetPath = join(aofRoot, path);
      await rm(targetPath, { recursive: true, force: true }); // Remove if exists in new version
      await cp(tempPath, targetPath, { recursive: true });
    }

    // Update version in config
    await updateVersionConfig(aofRoot, targetVersion);

    // Execute post-update hook
    if (hooks?.postUpdate) {
      await hooks.postUpdate({
        previousVersion: currentVersion,
        currentVersion: targetVersion,
        aofRoot,
      });
    }

    // Clean up temp directory
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }

    return {
      success: true,
      version: targetVersion,
      backupCreated: true,
      backupPath,
    };
  } catch (error) {
    // Rollback on failure
    if (backupPath) {
      try {
        await rollbackUpdate({
          aofRoot,
          backupPath,
          preservePaths,
        });
      } catch (rollbackError) {
        throw new Error(
          `Update failed and rollback also failed: ${error instanceof Error ? error.message : String(error)}; ` +
          `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }

    // Clean up temp directory
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    throw error;
  }
}

/**
 * Rollback to previous version from backup.
 */
export async function rollbackUpdate(opts: RollbackOptions): Promise<RollbackResult> {
  const { aofRoot, backupPath, preservePaths = [] } = opts;

  // Verify backup exists
  try {
    await access(backupPath);
  } catch {
    throw new Error(`Backup not found: ${backupPath}`);
  }

  // Get version from backup
  const restoredVersion = await getVersionFromBackup(backupPath);

  // Restore all paths from backup
  const allPaths = [".aof", ...preservePaths];

  for (const path of allPaths) {
    const sourcePath = join(backupPath, path);
    const targetPath = join(aofRoot, path);

    try {
      await access(sourcePath);
      await rm(targetPath, { recursive: true, force: true });
      await cp(sourcePath, targetPath, { recursive: true });
    } catch {
      // Path doesn't exist in backup, skip
    }
  }

  // Clean up backup
  await rm(backupPath, { recursive: true, force: true });

  return {
    success: true,
    restoredVersion,
  };
}

// --- Helper functions ---

async function getCurrentVersion(aofRoot: string): Promise<string> {
  const configPath = join(aofRoot, ".aof", "channel.json");

  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    return config.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function getVersionFromBackup(backupPath: string): Promise<string> {
  const configPath = join(backupPath, ".aof", "channel.json");

  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    return config.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function updateVersionConfig(aofRoot: string, version: string): Promise<void> {
  const configPath = join(aofRoot, ".aof", "channel.json");

  let config: Record<string, unknown> = {};
  try {
    const content = await readFile(configPath, "utf-8");
    config = JSON.parse(content);
  } catch {
    // New config
  }

  config.version = version;
  config.lastUpdated = new Date().toISOString();

  await mkdir(join(aofRoot, ".aof"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

async function createBackup(aofRoot: string, paths: string[]): Promise<string> {
  const backupRoot = join(aofRoot, BACKUP_DIR_NAME);
  const backupPath = join(backupRoot, `backup-${Date.now()}`);

  await mkdir(backupPath, { recursive: true });

  // Always backup .aof config
  const allPaths = [".aof", ...paths];

  for (const path of allPaths) {
    const sourcePath = join(aofRoot, path);
    const targetPath = join(backupPath, path);

    try {
      await access(sourcePath);
      await cp(sourcePath, targetPath, { recursive: true });
    } catch {
      // Path doesn't exist, skip
    }
  }

  return backupPath;
}

async function downloadFile(
  url: string,
  targetPath: string,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(
        `Download failed: HTTP ${response.status} ${response.statusText}`
      );
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    // Write to file
    const fileStream = createWriteStream(targetPath);
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream),
      fileStream
    );
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error("Download timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function extractTarball(tarballPath: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });

  try {
    execSync(`tar -xzf "${tarballPath}" -C "${targetDir}"`, {
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (error) {
    throw new Error(
      `Failed to extract tarball: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function mkdtemp(prefix: string): Promise<string> {
  return _mkdtemp(prefix);
}

async function readdir(path: string): Promise<string[]> {
  const entries = await _readdir(path);
  return entries.map(e => String(e));
}

function dirname(path: string): string {
  return _dirname(path);
}
