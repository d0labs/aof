import { join } from "node:path";
import { homedir } from "node:os";
import { registerAofPlugin } from "./openclaw/adapter.js";
import type { OpenClawApi } from "./openclaw/types.js";
import { registerMemoryModule } from "./memory/index.js";

type AofPluginConfig = {
  dataDir?: string;
  pollIntervalMs?: number;
  defaultLeaseTtlMs?: number;
  dryRun?: boolean;
  gatewayUrl?: string;
  gatewayToken?: string;
};

const DEFAULT_DATA_DIR = join(homedir(), ".openclaw", "aof");
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 300_000;
const DEFAULT_DRY_RUN = true;

const resolvePluginConfig = (api: OpenClawApi): AofPluginConfig => {
  const pluginConfig = api.pluginConfig as AofPluginConfig | undefined;
  if (pluginConfig && typeof pluginConfig === "object") return pluginConfig;

  const legacy = (api.config as Record<string, any> | undefined)?.plugins?.entries?.aof?.config;
  if (legacy && typeof legacy === "object") return legacy as AofPluginConfig;

  return {};
};

const expandHomeDir = (value: string): string => {
  return value.replace(/^~(?=$|[\\/])/, homedir());
};

const normalizeDataDir = (value: unknown): string => {
  if (typeof value !== "string") return DEFAULT_DATA_DIR;
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_DATA_DIR;
  return expandHomeDir(trimmed);
};

const normalizeNumber = (value: unknown, fallback: number): number => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  return typeof value === "boolean" ? value : fallback;
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const plugin = {
  id: "aof",
  name: "AOF — Agentic Ops Fabric",
  description: "Deterministic task orchestration for multi-agent systems",

  register(api: OpenClawApi): void {
    const config = resolvePluginConfig(api);
    const dataDir = normalizeDataDir(config.dataDir);
    const pollIntervalMs = normalizeNumber(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    const defaultLeaseTtlMs = normalizeNumber(config.defaultLeaseTtlMs, DEFAULT_LEASE_TTL_MS);
    const dryRun = normalizeBoolean(config.dryRun, DEFAULT_DRY_RUN);
    const gatewayUrl = normalizeString(config.gatewayUrl);
    const gatewayToken = normalizeString(config.gatewayToken);

    try {
      registerAofPlugin(api, {
        dataDir,
        pollIntervalMs,
        defaultLeaseTtlMs,
        dryRun,
        gatewayUrl,
        gatewayToken,
      });

      registerMemoryModule(api);

      api.logger?.info?.(`[AOF] Plugin loaded — dataDir=${dataDir}, dryRun=${dryRun}, poll=${pollIntervalMs}ms`);
    } catch (err) {
      const message = `[AOF] Plugin registration failed: ${String(err)}`;
      api.logger?.error?.(message);
    }
  },
};;

export default plugin;
