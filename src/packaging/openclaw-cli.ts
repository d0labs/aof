/**
 * OpenClaw CLI wrapper — safe config access via `openclaw config` commands.
 *
 * CRITICAL: Never import node:fs or edit openclaw.json directly.
 * All config changes go through `openclaw config set` to avoid crashes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const execFileAsync = promisify(execFile);

export interface OpenClawDetection {
  detected: boolean;
  configPath?: string;
  version?: string;
}

export interface MemoryPluginInfo {
  /** Plugin ID from slots.memory */
  slotHolder?: string;
  /** Plugins with kind="memory" or known memory plugins in the allow list */
  candidates: string[];
}

/**
 * Run `openclaw config get <path>` and return parsed JSON value.
 * Returns undefined if path not found or openclaw not available.
 */
export async function openclawConfigGet(path: string): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("openclaw", ["config", "get", path, "--json"], {
      timeout: 10_000,
    });
    // Strip config warnings (lines starting with "Config warnings")
    const clean = stdout
      .split("\n")
      .filter((l) => !l.startsWith("Config warnings"))
      .join("\n")
      .trim();
    return JSON.parse(clean);
  } catch {
    return undefined;
  }
}

/**
 * Run `openclaw config set <path> <value>` with JSON encoding.
 * Throws on failure.
 */
/**
 * Run `openclaw config set <path> <value>` with JSON encoding.
 * Throws on failure (non-zero exit code).
 */
export async function openclawConfigSet(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  try {
    await execFileAsync(
      "openclaw",
      ["config", "set", path, serialized, "--json"],
      { timeout: 10_000 },
    );
  } catch (err) {
    // execFile throws on non-zero exit — extract meaningful message from stderr/stdout
    const anyErr = err as { stderr?: string; stdout?: string; message?: string };
    const raw = anyErr.stderr ?? anyErr.stdout ?? anyErr.message ?? String(err);
    // Strip noise: config warnings header and backup/overwrite notices
    const meaningful = raw
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        if (!t) return false;
        if (t.startsWith("Config warnings:")) return false;
        if (t.startsWith("Config overwrite:")) return false;
        if (t.startsWith("- plugins.entries.matrix:")) return false; // known duplicate warning
        return true;
      })
      .join("\n")
      .trim();
    throw new Error(meaningful || String(err));
  }
}

/**
 * Run `openclaw config unset <path>`.
 * Throws on failure.
 */
export async function openclawConfigUnset(path: string): Promise<void> {
  await execFileAsync("openclaw", ["config", "unset", path], { timeout: 10_000 });
}

/**
 * Detect whether OpenClaw is installed and the config file is present.
 */
export async function detectOpenClaw(homeDir = homedir()): Promise<OpenClawDetection> {
  const configPath = join(homeDir, ".openclaw", "openclaw.json");
  try {
    await access(configPath);
  } catch {
    return { detected: false };
  }
  // Try to get version
  try {
    const { stdout } = await execFileAsync("openclaw", ["--version"], { timeout: 5_000 });
    return { detected: true, configPath, version: stdout.trim() };
  } catch {
    return { detected: true, configPath };
  }
}

/**
 * Check whether AOF is already registered as an OpenClaw plugin.
 */
export async function isAofPluginRegistered(): Promise<boolean> {
  const entry = await openclawConfigGet("plugins.entries.aof");
  return entry !== undefined;
}

/**
 * Check whether AOF is in the plugin allow list.
 */
export async function isAofInAllowList(): Promise<boolean> {
  const allowList = (await openclawConfigGet("plugins.allow")) as string[] | undefined;
  return Array.isArray(allowList) && allowList.includes("aof");
}

/**
 * Add AOF to the allow list if not already present.
 */
export async function addAofToAllowList(): Promise<void> {
  const allowList = ((await openclawConfigGet("plugins.allow")) as string[] | undefined) ?? [];
  if (!allowList.includes("aof")) {
    await openclawConfigSet("plugins.allow", [...allowList, "aof"]);
  }
}

/**
 * Register AOF as a plugin entry (idempotent).
 * @param pluginJsonPath - Absolute path to openclaw.plugin.json
 */
/**
 * Register AOF as a plugin entry (idempotent).
 * The `path` is NOT set here — OpenClaw resolves the plugin via npm/node_modules.
 * @param _pluginJsonPath - reserved for future use / health checks
 */
export async function registerAofPlugin(_pluginJsonPath: string): Promise<void> {
  await openclawConfigSet("plugins.entries.aof", { enabled: true });
  await addAofToAllowList();
}

/**
 * Detect the current memory plugin slot holder and candidates.
 */
export async function detectMemoryPlugin(): Promise<MemoryPluginInfo> {
  const slotHolder = (await openclawConfigGet("plugins.slots.memory")) as string | undefined;
  const candidates: string[] = [];

  if (slotHolder && slotHolder !== "aof") {
    candidates.push(slotHolder);
  }

  // Also check entries for known memory plugins not in slots
  const entries = (await openclawConfigGet("plugins.entries")) as Record<string, { enabled?: boolean }> | undefined;
  if (entries) {
    const knownMemory = ["memory-core", "memory-plugin", "mem0"];
    for (const id of knownMemory) {
      if (entries[id]?.enabled && !candidates.includes(id)) {
        candidates.push(id);
      }
    }
  }

  return { slotHolder, candidates };
}

/**
 * Configure AOF as the memory plugin.
 * Disables the current memory slot holder and sets slots.memory to "aof".
 */
export async function configureAofAsMemoryPlugin(currentPlugin?: string): Promise<void> {
  // Disable current memory plugin if known (but never disable ourselves)
  if (currentPlugin && currentPlugin !== "aof") {
    await openclawConfigSet(`plugins.entries.${currentPlugin}.enabled`, false);
  }
  // Set memory slot to aof
  await openclawConfigSet("plugins.slots.memory", "aof");
  // Enable AOF's memory module
  await openclawConfigSet("plugins.entries.aof.config.modules.memory.enabled", true);
}

/**
 * Check if AOF's memory module is currently enabled.
 */
export async function isAofMemoryEnabled(): Promise<boolean> {
  const val = await openclawConfigGet("plugins.entries.aof.config.modules.memory.enabled");
  return val === true;
}

/**
 * Check if slots.memory is set to "aof".
 */
export async function isAofMemorySlot(): Promise<boolean> {
  const slot = await openclawConfigGet("plugins.slots.memory");
  return slot === "aof";
}
