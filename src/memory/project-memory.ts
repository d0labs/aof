import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { initMemoryDb } from "./store/schema.js";
import { VectorStore } from "./store/vector-store.js";
import { HnswIndex } from "./store/hnsw-index.js";
import { FtsStore } from "./store/fts-store.js";
import { HybridSearchEngine } from "./store/hybrid-search.js";
import type { SqliteDb } from "./types.js";

export interface ProjectMemoryStore {
  db: SqliteDb;
  hnsw: HnswIndex;
  vectorStore: VectorStore;
  ftsStore: FtsStore;
  searchEngine: HybridSearchEngine;
  hnswPath: string;
}

// Cache of initialized project memory stores (lazy, one per project)
const projectMemoryCache = new Map<string, ProjectMemoryStore>();

/**
 * Rebuild the HNSW index from all embeddings stored in sqlite vec_chunks.
 * Inlined from index.ts to avoid circular dependency (project-memory -> index -> project-memory).
 */
function rebuildHnswFromDb(db: SqliteDb, hnsw: HnswIndex): void {
  const rows = db
    .prepare("SELECT chunk_id, embedding FROM vec_chunks")
    .all() as Array<{ chunk_id: bigint; embedding: Buffer }>;

  const chunks = rows.map((row) => ({
    id: Number(row.chunk_id),
    embedding: Array.from(new Float32Array(row.embedding.buffer)),
  }));

  hnsw.rebuild(chunks);

  // Track last rebuild time in memory_meta
  db.exec("CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('last_rebuild_time', datetime('now'))").run();
}

/**
 * Get or create a memory store for a specific project.
 * Lazy initialization -- the store is created on first access.
 *
 * @param projectRoot - Absolute path to the project directory (e.g., <vaultRoot>/Projects/<id>)
 * @param dimensions - Embedding dimensions (must match the global embedding config)
 * @returns ProjectMemoryStore with isolated DB + HNSW index
 */
export function getProjectMemoryStore(projectRoot: string, dimensions: number): ProjectMemoryStore {
  const cached = projectMemoryCache.get(projectRoot);
  if (cached) return cached;

  const memoryDir = join(projectRoot, "memory");
  mkdirSync(memoryDir, { recursive: true });

  const dbPath = join(memoryDir, "memory.db");
  const hnswPath = join(memoryDir, "memory-hnsw.dat");

  const db = initMemoryDb(dbPath, dimensions);
  const hnsw = new HnswIndex(dimensions);

  // Ensure memory_meta table exists for rebuild tracking
  db.exec("CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)");

  let needsRebuild = false;

  if (existsSync(hnswPath)) {
    try {
      hnsw.load(hnswPath);
    } catch {
      console.warn(`[AOF] Project memory HNSW index corrupt at ${hnswPath}. Rebuilding...`);
      needsRebuild = true;
    }
  } else {
    // No index file yet -- rebuild from SQLite (which may also be empty for new projects)
    needsRebuild = true;
  }

  // Parity check (same as global memory startup in Phase 4)
  if (!needsRebuild) {
    const hnswCount = hnsw.count;
    const sqliteCount = (db.prepare("SELECT COUNT(*) as c FROM vec_chunks").get() as { c: number }).c;
    if (hnswCount !== sqliteCount) {
      console.warn(
        `[AOF] Project memory HNSW-SQLite desync at ${projectRoot} (HNSW: ${hnswCount}, SQLite: ${sqliteCount}). Rebuilding...`,
      );
      needsRebuild = true;
    }
  }

  if (needsRebuild) {
    rebuildHnswFromDb(db, hnsw);
    // Only save if there are chunks to save (empty index save can cause issues)
    if (hnsw.count > 0) {
      hnsw.save(hnswPath);
    }
  }

  const vectorStore = new VectorStore(db, hnsw, hnswPath);
  const ftsStore = new FtsStore(db);
  const searchEngine = new HybridSearchEngine(vectorStore, ftsStore);

  const store: ProjectMemoryStore = { db, hnsw, vectorStore, ftsStore, searchEngine, hnswPath };
  projectMemoryCache.set(projectRoot, store);

  return store;
}

/**
 * Save all project memory HNSW indices to disk.
 * Called during graceful shutdown.
 */
export function saveAllProjectMemory(): void {
  for (const [projectRoot, store] of projectMemoryCache) {
    try {
      if (store.hnsw.count > 0) {
        store.hnsw.save(store.hnswPath);
      }
    } catch (err) {
      console.error(`[AOF] Failed to save project memory HNSW at ${projectRoot}: ${(err as Error).message}`);
    }
  }
}

/**
 * Clear the project memory cache. Used in tests.
 */
export function clearProjectMemoryCache(): void {
  projectMemoryCache.clear();
}
