import { join } from "node:path";
import { homedir } from "node:os";
import type { OpenClawApi } from "../openclaw/types.js";
import type { SqliteDb } from "./types.js";
import { existsSync } from "node:fs";
import { initMemoryDb } from "./store/schema.js";
import { VectorStore } from "./store/vector-store.js";
import { HnswIndex } from "./store/hnsw-index.js";
import { FtsStore } from "./store/fts-store.js";
import { HybridSearchEngine } from "./store/hybrid-search.js";
import { createReranker } from "./store/reranker.js";
import type { RerankerConfig } from "./store/reranker.js";
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
  reranker?: RerankerConfig;
}

interface _PluginConfig {
  dataDir?: string;
  modules?: { memory?: { enabled?: boolean } };
  memory?: _MemoryModuleConfig;
}

function _expandPath(p: string): string {
  return p.replace(/^~(?=$|[/\\])/, homedir());
}

/** Ensure the memory_meta table exists for tracking rebuild metadata. */
function ensureMemoryMeta(db: SqliteDb): void {
  db.exec("CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)");
}

/** Rebuild the HNSW index from all embeddings stored in sqlite vec_chunks. */
export function rebuildHnswFromDb(db: SqliteDb, hnsw: HnswIndex): void {
  const rows = db
    .prepare("SELECT chunk_id, embedding FROM vec_chunks")
    .all() as Array<{ chunk_id: bigint; embedding: Buffer }>;

  const chunks = rows.map((row) => ({
    id: Number(row.chunk_id),
    embedding: Array.from(new Float32Array(row.embedding.buffer)),
  }));

  hnsw.rebuild(chunks);

  // Track last rebuild time in memory_meta
  ensureMemoryMeta(db);
  db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('last_rebuild_time', datetime('now'))").run();
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

  const hnswPath = dbPath.replace(/\.db$/, "-hnsw.dat");
  const hnsw = new HnswIndex(dimensions);
  ensureMemoryMeta(db);

  let needsRebuild = false;

  if (existsSync(hnswPath)) {
    try {
      hnsw.load(hnswPath);
    } catch {
      // Corrupt or incompatible index file
      console.warn("[AOF] HNSW index corrupt or incompatible. Rebuilding from SQLite...");
      needsRebuild = true;
    }
  } else {
    console.warn("[AOF] HNSW index missing. Rebuilding from SQLite...");
    needsRebuild = true;
  }

  // Parity check: compare HNSW count to SQLite count every startup
  if (!needsRebuild) {
    const hnswCount = hnsw.count;
    const sqliteCount = (db.prepare("SELECT COUNT(*) as c FROM vec_chunks").get() as { c: number }).c;
    if (hnswCount !== sqliteCount) {
      console.warn(
        `[AOF] HNSW-SQLite desync detected (HNSW: ${hnswCount}, SQLite: ${sqliteCount}). Rebuilding index...`,
      );
      needsRebuild = true;
    }
  }

  if (needsRebuild) {
    rebuildHnswFromDb(db, hnsw);
    // Persist the freshly rebuilt index to disk
    hnsw.save(hnswPath);
  }

  const vectorStore = new VectorStore(db, hnsw, hnswPath);
  const ftsStore = new FtsStore(db);
  const searchEngine = new HybridSearchEngine(vectorStore, ftsStore);

  const embeddingProvider = new OpenAIEmbeddingProvider({
    model: embCfg.model,
    baseUrl: embCfg.baseUrl,
    apiKey: embCfg.apiKey ?? process.env.OPENAI_API_KEY,
    dimensions,
  });

  const poolPaths: Record<string, string> =
    memoryCfg.poolPaths ?? { core: join(dataDir, "memory") };
  const defaultPool = memoryCfg.defaultPool ?? "core";
  const defaultTier = memoryCfg.defaultTier ?? "hot";
  const defaultLimit = memoryCfg.defaultLimit ?? 20;

  const reranker = memoryCfg.reranker
    ? createReranker(memoryCfg.reranker)
    : null;
  const topKBeforeRerank = memoryCfg.reranker?.topKBeforeRerank;

  api.registerTool(
    createMemorySearchTool({
      embeddingProvider,
      searchEngine,
      ...(reranker ? { reranker, topKBeforeRerank } : {}),
    }),
  );
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
      try {
        hnsw.save(hnswPath);
      } catch {
        // Non-critical: index will be rebuilt from sqlite on next start
      }
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
