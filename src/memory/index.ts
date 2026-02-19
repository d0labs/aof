import { join } from "node:path";
import { homedir } from "node:os";
import type { OpenClawApi } from "../openclaw/types.js";
import { initMemoryDb } from "./store/schema.js";
import { VectorStore } from "./store/vector-store.js";
import { FtsStore } from "./store/fts-store.js";
import { HybridSearchEngine } from "./store/hybrid-search.js";
import { OpenAIEmbeddingProvider } from "./embeddings/openai-provider.js";
import { createMemorySearchTool } from "./tools/search.js";
import { createMemoryStoreTool } from "./tools/store.js";
import { createMemoryUpdateTool } from "./tools/update.js";
import { createMemoryDeleteTool } from "./tools/delete.js";
import { createMemoryListTool } from "./tools/list.js";
import { memoryGetTool } from "./tools/get.js";
import { IndexSyncService } from "./tools/indexing.js";

export { generateMemoryConfig, resolvePoolPath } from "./generator.js";
export { auditMemoryConfig, formatMemoryAuditReport } from "./audit.js";

// ─── Memory module registration (AOF-a39) ────────────────────────────────────

interface _EmbeddingConfig {
  provider?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
}

interface _MemoryModuleConfig {
  enabled?: boolean;
  embedding?: _EmbeddingConfig;
  indexPaths?: string[];
  scanIntervalMs?: number;
  dbPath?: string;
  poolPaths?: Record<string, string>;
  defaultPool?: string;
  defaultTier?: string;
  defaultLimit?: number;
}

interface _PluginConfig {
  dataDir?: string;
  modules?: { memory?: { enabled?: boolean } };
  memory?: _MemoryModuleConfig;
}

function _expandPath(p: string): string {
  return p.replace(/^~(?=$|[/\\])/, homedir());
}

export function registerMemoryModule(api: OpenClawApi): void {
  const raw = api.pluginConfig as _PluginConfig | undefined;
  const enabled = raw?.modules?.memory?.enabled ?? raw?.memory?.enabled ?? false;
  if (!enabled) return;

  const memoryCfg: _MemoryModuleConfig = raw?.memory ?? {};
  const embCfg = memoryCfg.embedding ?? { model: "nomic-embed-text" };
  const dimensions = embCfg.dimensions ?? 768;

  const rawDataDir = raw?.dataDir ?? "~/.openclaw/aof";
  const dataDir = _expandPath(rawDataDir);
  const dbPath = memoryCfg.dbPath ? _expandPath(memoryCfg.dbPath) : join(dataDir, "memory.db");

  const db = initMemoryDb(dbPath, dimensions);
  const vectorStore = new VectorStore(db);
  const ftsStore = new FtsStore(db);
  const searchEngine = new HybridSearchEngine(vectorStore, ftsStore);

  const embeddingProvider = new OpenAIEmbeddingProvider({
    model: embCfg.model,
    baseUrl: embCfg.baseUrl,
    apiKey: embCfg.apiKey,
    dimensions,
  });

  const poolPaths: Record<string, string> =
    memoryCfg.poolPaths ?? { core: join(dataDir, "memory") };
  const defaultPool = memoryCfg.defaultPool ?? "core";
  const defaultTier = memoryCfg.defaultTier ?? "hot";
  const defaultLimit = memoryCfg.defaultLimit ?? 20;

  api.registerTool(createMemorySearchTool({ embeddingProvider, searchEngine }));
  api.registerTool(createMemoryStoreTool({ db, embeddingProvider, vectorStore, ftsStore, poolPaths, defaultPool, defaultTier }));
  api.registerTool(createMemoryUpdateTool({ db, embeddingProvider, vectorStore, ftsStore }));
  api.registerTool(createMemoryDeleteTool({ db, vectorStore, ftsStore }));
  api.registerTool(createMemoryListTool({ db, defaultLimit }));
  api.registerTool(memoryGetTool);

  const syncService = new IndexSyncService({
    db,
    embeddingProvider,
    vectorStore,
    ftsStore,
    indexPaths: memoryCfg.indexPaths ?? [],
    scanIntervalMs: memoryCfg.scanIntervalMs,
  });

  api.registerService({
    id: "memory-index-sync",
    start: async () => {
      await syncService.runOnce();
      syncService.start();
    },
    stop: () => {
      syncService.stop();
    },
  });
}

export { ColdTier } from "./cold-tier.js";
export { WarmAggregator } from "./warm-aggregation.js";
export { HotPromotion } from "./hot-promotion.js";
export type {
  MemoryConfig,
  MemoryConfigOptions,
  MemoryConfigResult,
  AgentMemoryExplanation,
  PoolMatch,
} from "./generator.js";
export type { OpenClawConfig, MemoryAuditEntry, MemoryAuditReport } from "./audit.js";
export type { ColdTierOptions, IncidentReport } from "./cold-tier.js";
export type {
  AggregationRule,
  AggregationOptions,
  AggregationResult,
} from "./warm-aggregation.js";
export type { PromotionOptions, PromotionResult } from "./hot-promotion.js";
