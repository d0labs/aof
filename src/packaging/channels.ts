/**
 * AOF Channel Infrastructure
 * Manages release channels (stable/beta/canary), version manifests, and rollback.
 */

import { readFile, writeFile, mkdir, access, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type Channel = "stable" | "beta" | "canary";

export interface VersionManifest {
  channel: Channel;
  version: string;
  publishedAt: string;
  changelog: string;
}

export interface UpdatePolicy {
  autoCheckIntervalMs: number;
  mode: "notify" | "prompt" | "auto";
}

export interface ChannelConfig {
  channel: Channel;
  version?: string;
  lastCheck?: string;
  updatePolicy?: UpdatePolicy;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion?: string;
  latestVersion?: string;
  manifest?: VersionManifest;
  skipped?: boolean;
  reason?: string;
}

const VALID_CHANNELS: Channel[] = ["stable", "beta", "canary"];
const DEFAULT_CHANNEL: Channel = "stable";
const GITHUB_REPO = "demerzel-ops/aof";
const BACKUP_DIR_NAME = ".aof-backup";

/**
 * Get current channel.
 */
export async function getChannel(aofRoot: string): Promise<Channel> {
  const configPath = join(aofRoot, ".aof", "channel.json");

  try {
    await access(configPath);
    const content = await readFile(configPath, "utf-8");
    const config: ChannelConfig = JSON.parse(content);

    if (VALID_CHANNELS.includes(config.channel)) {
      return config.channel;
    }
  } catch {
    // Config doesn't exist or invalid
  }

  return DEFAULT_CHANNEL;
}

/**
 * Set channel.
 */
export async function setChannel(aofRoot: string, channel: Channel): Promise<void> {
  if (!VALID_CHANNELS.includes(channel)) {
    throw new Error(`Invalid channel: ${channel}. Valid channels: ${VALID_CHANNELS.join(", ")}`);
  }

  const configDir = join(aofRoot, ".aof");
  const configPath = join(configDir, "channel.json");

  // Ensure directory exists
  await mkdir(configDir, { recursive: true });

  // Read existing config or create new
  let config: ChannelConfig = { channel };
  try {
    await access(configPath);
    const content = await readFile(configPath, "utf-8");
    config = { ...JSON.parse(content), channel };
  } catch {
    // New config
  }

  await writeFile(configPath, JSON.stringify(config, null, 2));
}

/**
 * Fetch version manifest for a channel.
 */
export async function getVersionManifest(
  channel: Channel,
  opts?: { timeoutMs?: number }
): Promise<VersionManifest> {
  const timeoutMs = opts?.timeoutMs ?? 5000;

  if (channel === "canary") {
    return fetchCanaryManifest(timeoutMs);
  }

  return fetchReleaseManifest(channel, timeoutMs);
}

/**
 * Check for updates.
 */
export async function checkForUpdates(
  aofRoot: string,
  opts?: { timeoutMs?: number; force?: boolean }
): Promise<UpdateCheckResult> {
  const configPath = join(aofRoot, ".aof", "channel.json");
  let config: ChannelConfig;

  try {
    await access(configPath);
    const content = await readFile(configPath, "utf-8");
    config = JSON.parse(content);
  } catch {
    config = { channel: DEFAULT_CHANNEL };
  }

  // Check if we should skip (interval not elapsed)
  if (!opts?.force && config.lastCheck && config.updatePolicy?.autoCheckIntervalMs) {
    const lastCheck = new Date(config.lastCheck).getTime();
    const now = Date.now();
    const elapsed = now - lastCheck;

    if (elapsed < config.updatePolicy.autoCheckIntervalMs) {
      return {
        updateAvailable: false,
        skipped: true,
        reason: "checked-recently",
      };
    }
  }

  // Fetch latest version
  const manifest = await getVersionManifest(config.channel, { timeoutMs: opts?.timeoutMs });

  // Update last check time
  config.lastCheck = new Date().toISOString();
  await mkdir(join(aofRoot, ".aof"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const currentVersion = config.version;
  const latestVersion = manifest.version;

  const updateAvailable = currentVersion !== latestVersion && currentVersion !== undefined;

  return {
    updateAvailable,
    currentVersion,
    latestVersion,
    manifest,
  };
}

/**
 * Create backup of specified paths.
 */
export async function createBackup(aofRoot: string, paths: string[]): Promise<string> {
  const backupRoot = join(aofRoot, BACKUP_DIR_NAME);
  const backupPath = join(backupRoot, `backup-${Date.now()}`);

  await mkdir(backupPath, { recursive: true });

  for (const path of paths) {
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

/**
 * Rollback from backup.
 */
export async function rollback(
  backupPath: string,
  aofRoot: string,
  paths: string[]
): Promise<void> {
  for (const path of paths) {
    const sourcePath = join(backupPath, path);
    const targetPath = join(aofRoot, path);

    try {
      await access(sourcePath);
      await rm(targetPath, { recursive: true, force: true });
      await cp(sourcePath, targetPath, { recursive: true });
    } catch {
      // Backup doesn't exist for this path, skip
    }
  }

  // Clean up backup
  await rm(backupPath, { recursive: true, force: true });
}

// --- Helper functions ---

async function fetchReleaseManifest(
  channel: Channel,
  timeoutMs: number
): Promise<VersionManifest> {
  const url =
    channel === "stable"
      ? `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
      : `https://api.github.com/repos/${GITHUB_REPO}/releases`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Failed to fetch version manifest: HTTP ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown> | Record<string, unknown>[];

    // Handle beta (find first RC)
    if (channel === "beta") {
      const rcRelease = Array.isArray(data)
        ? data.find((r) => String((r as Record<string, unknown>).tag_name ?? "").includes("-rc"))
        : null;

      if (!rcRelease) {
        throw new Error("No beta release found");
      }

      return parseReleaseData(rcRelease as { tag_name: string; name: string; body: string; published_at: string }, channel);
    }

    // Stable (single release)
    return parseReleaseData(data as { tag_name: string; name: string; body: string; published_at: string }, channel);
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCanaryManifest(timeoutMs: number): Promise<VersionManifest> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/commits/main`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Failed to fetch canary manifest: HTTP ${response.status}`);
    }

    const data = await response.json() as { sha: string; commit: { author: { date: string }; message: string } };

    return {
      channel: "canary",
      version: `canary-${data.sha.substring(0, 7)}`,
      publishedAt: data.commit.author.date,
      changelog: data.commit.message,
    };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseReleaseData(data: {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
}, channel: Channel): VersionManifest {
  // Strip 'v' prefix from tag
  const version = data.tag_name.replace(/^v/, "");

  return {
    channel,
    version,
    publishedAt: data.published_at,
    changelog: data.body,
  };
}
