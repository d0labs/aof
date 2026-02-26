import type { SqliteDb } from "../types.js";

import { parseTags, serializeTags } from "./tag-serialization.js";
import type { HnswIndex } from "./hnsw-index.js";

const INSERT_CHUNK_SQL = `
  INSERT INTO chunks (
    file_path,
    chunk_index,
    content,
    tier,
    pool,
    importance,
    tags,
    created_at,
    updated_at,
    accessed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_VECTOR_SQL = "INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)";
const UPDATE_VECTOR_SQL = "UPDATE vec_chunks SET embedding = ? WHERE chunk_id = ?";
const DELETE_VECTOR_SQL = "DELETE FROM vec_chunks WHERE chunk_id = ?";
const DELETE_VECTORS_BY_FILE_SQL =
  "DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)";
const DELETE_CHUNK_SQL = "DELETE FROM chunks WHERE id = ?";
const DELETE_CHUNKS_BY_FILE_SQL = "DELETE FROM chunks WHERE file_path = ?";
const GET_CHUNK_IDS_BY_FILE_SQL = "SELECT id FROM chunks WHERE file_path = ?";

const GET_CHUNK_SQL = `
  SELECT
    id,
    file_path as filePath,
    chunk_index as chunkIndex,
    content,
    tier,
    pool,
    importance,
    tags,
    created_at as createdAt,
    updated_at as updatedAt,
    accessed_at as accessedAt
  FROM chunks
  WHERE id = ?
`;

const SEARCH_SQL = `
  SELECT
    chunks.id as id,
    chunks.file_path as filePath,
    chunks.chunk_index as chunkIndex,
    chunks.content as content,
    chunks.tier as tier,
    chunks.pool as pool,
    chunks.importance as importance,
    chunks.tags as tags,
    chunks.created_at as createdAt,
    chunks.updated_at as updatedAt,
    chunks.accessed_at as accessedAt,
    vec_chunks.distance as distance
  FROM vec_chunks
  JOIN chunks ON chunks.id = vec_chunks.chunk_id
  WHERE vec_chunks.embedding MATCH ?
    AND k = CAST(? AS INTEGER)
  ORDER BY vec_chunks.distance
`;

export type VectorChunkInput = {
  filePath: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  tier?: string | null;
  pool?: string | null;
  importance?: number | null;
  tags?: string[] | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  accessedAt?: number | null;
};

export type VectorChunkRecord = Omit<VectorChunkInput, "embedding"> & {
  id: number;
  tags: string[] | null;
  createdAt: number | null;
  updatedAt: number | null;
  accessedAt: number | null;
};

export type VectorChunkUpdate = {
  content?: string;
  embedding?: number[];
  tier?: string | null;
  pool?: string | null;
  importance?: number | null;
  tags?: string[] | null;
  updatedAt?: number | null;
  accessedAt?: number | null;
};

export type VectorSearchResult = VectorChunkRecord & {
  distance: number;
};

type ChunkRow = {
  id: number;
  filePath: string;
  chunkIndex: number;
  content: string;
  tier: string | null;
  pool: string | null;
  importance: number | null;
  tags: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  accessedAt: number | null;
};

type VectorSearchRow = ChunkRow & {
  distance: number;
};

const CHUNK_UPDATE_COLUMNS: Record<
  keyof Omit<VectorChunkUpdate, "embedding">,
  string
> = {
  content: "content",
  tier: "tier",
  pool: "pool",
  importance: "importance",
  tags: "tags",
  updatedAt: "updated_at",
  accessedAt: "accessed_at",
};

/**
 * Simple promise-based mutex for serializing async HNSW mutations.
 * Node.js is single-threaded but async operations can interleave at await points.
 */
class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

export class VectorStore {
  private readonly db: SqliteDb;
  private readonly hnsw: HnswIndex | null;
  private readonly hnswPath: string | null;
  private readonly mutex = new Mutex();

  /** When true, search falls back to sqlite-vec (used during rebuild). */
  rebuilding = false;

  private readonly insertChunkStmt;
  private readonly insertVectorStmt;
  private readonly updateVectorStmt;
  private readonly deleteVectorStmt;
  private readonly deleteVectorsByFileStmt;
  private readonly deleteChunkStmt;
  private readonly deleteChunksByFileStmt;
  private readonly getChunkIdsByFileStmt;
  private readonly getChunkStmt;
  private readonly searchStmt;

  constructor(db: SqliteDb, hnsw: HnswIndex | null = null, hnswPath?: string) {
    this.db = db;
    this.hnsw = hnsw;
    this.hnswPath = hnswPath ?? null;
    this.insertChunkStmt = db.prepare(INSERT_CHUNK_SQL);
    this.insertVectorStmt = db.prepare(INSERT_VECTOR_SQL);
    this.updateVectorStmt = db.prepare(UPDATE_VECTOR_SQL);
    this.deleteVectorStmt = db.prepare(DELETE_VECTOR_SQL);
    this.deleteVectorsByFileStmt = db.prepare(DELETE_VECTORS_BY_FILE_SQL);
    this.deleteChunkStmt = db.prepare(DELETE_CHUNK_SQL);
    this.deleteChunksByFileStmt = db.prepare(DELETE_CHUNKS_BY_FILE_SQL);
    this.getChunkIdsByFileStmt = db.prepare(GET_CHUNK_IDS_BY_FILE_SQL);
    this.getChunkStmt = db.prepare(GET_CHUNK_SQL);
    this.searchStmt = db.prepare(SEARCH_SQL);
  }

  insertChunk(input: VectorChunkInput): number {
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const accessedAt = input.accessedAt ?? now;

    const insert = this.db.transaction(() => {
      const result = this.insertChunkStmt.run(
        input.filePath,
        input.chunkIndex,
        input.content,
        input.tier ?? null,
        input.pool ?? null,
        input.importance ?? null,
        serializeTags(input.tags),
        createdAt,
        updatedAt,
        accessedAt
      );

      const chunkId = Number(result.lastInsertRowid);
      this.insertVectorStmt.run(
        toVecChunkId(chunkId),
        new Float32Array(input.embedding)
      );

      return chunkId;
    });

    const chunkId = insert();

    this.hnsw?.add(chunkId, input.embedding);
    this.saveIndex();

    return chunkId;
  }

  getChunk(id: number): VectorChunkRecord | null {
    const row = this.getChunkStmt.get(id) as ChunkRow | undefined;
    if (!row) {
      return null;
    }

    return mapChunkRow(row);
  }

  updateChunk(id: number, update: VectorChunkUpdate): void {
    const metadata = buildChunkUpdate(update);
    if (metadata.sql) {
      const statement = this.db.prepare(
        `UPDATE chunks SET ${metadata.sql} WHERE id = ?`
      );
      statement.run(...metadata.params, id);
    }

    if (update.embedding) {
      this.updateVectorStmt.run(
        new Float32Array(update.embedding),
        toVecChunkId(id)
      );
      this.hnsw?.update(id, update.embedding);
      this.saveIndex();
    }
  }

  deleteChunk(id: number): void {
    const remove = this.db.transaction(() => {
      this.deleteVectorStmt.run(toVecChunkId(id));
      this.deleteChunkStmt.run(id);
    });

    remove();
    this.hnsw?.remove(id);
    this.saveIndex();
  }

  deleteChunksByFile(filePath: string): number {
    const chunkIds = this.hnsw
      ? (this.getChunkIdsByFileStmt.all(filePath) as Array<{ id: number }>).map(
          (row) => row.id
        )
      : null;

    const remove = this.db.transaction(() => {
      this.deleteVectorsByFileStmt.run(filePath);
      const result = this.deleteChunksByFileStmt.run(filePath);
      return result.changes;
    });

    const count = remove();

    if (chunkIds) {
      for (const id of chunkIds) {
        this.hnsw!.remove(id);
      }
      this.saveIndex();
    }

    return count;
  }

  search(embedding: number[], limit: number): VectorSearchResult[] {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    const k = Math.floor(limit);

    // During rebuild, fall back to sqlite-vec for uninterrupted (lower quality) search
    if (this.hnsw && !this.rebuilding) {
      return this.searchWithHnsw(embedding, k);
    }

    return this.searchWithSqliteVec(embedding, k);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /** Persist the HNSW index to disk for crash safety. */
  private saveIndex(): void {
    if (this.hnsw && this.hnswPath) {
      this.hnsw.save(this.hnswPath);
    }
  }

  private searchWithHnsw(embedding: number[], k: number): VectorSearchResult[] {
    const hits = this.hnsw!.search(embedding, k);
    if (hits.length === 0) return [];

    const distanceById = new Map(hits.map((h) => [h.id, h.distance]));
    const ids = hits.map((h) => h.id);

    const placeholders = ids.map(() => "?").join(", ");
    const sql = `
      SELECT
        id,
        file_path as filePath,
        chunk_index as chunkIndex,
        content,
        tier,
        pool,
        importance,
        tags,
        created_at as createdAt,
        updated_at as updatedAt,
        accessed_at as accessedAt
      FROM chunks
      WHERE id IN (${placeholders})
    `;
    const rows = this.db.prepare(sql).all(...ids) as ChunkRow[];

    return rows
      .map((row) => ({
        ...mapChunkRow(row),
        distance: distanceById.get(row.id) ?? 0,
      }))
      .sort((a, b) => a.distance - b.distance);
  }

  private searchWithSqliteVec(embedding: number[], k: number): VectorSearchResult[] {
    const rows = this.searchStmt.all(
      new Float32Array(embedding),
      k
    ) as VectorSearchRow[];

    return rows.map((row) => ({
      ...mapChunkRow(row),
      distance: row.distance,
    }));
  }
}

const toVecChunkId = (value: number): bigint => {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`Invalid vec_chunks id: ${value}`);
  }

  return BigInt(value);
};

function buildChunkUpdate(update: VectorChunkUpdate): {
  sql: string;
  params: Array<string | number | null>;
} {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  (Object.keys(CHUNK_UPDATE_COLUMNS) as Array<keyof typeof CHUNK_UPDATE_COLUMNS>)
    .forEach((key) => {
      const value = update[key];
      if (value === undefined) {
        return;
      }

      sets.push(`${CHUNK_UPDATE_COLUMNS[key]} = ?`);
      params.push(key === "tags" ? serializeTags(value as string[] | null) : (value as string | number | null) ?? null);
    });

  return {
    sql: sets.join(", "),
    params,
  };
}

function mapChunkRow(row: ChunkRow): VectorChunkRecord {
  return {
    id: row.id,
    filePath: row.filePath,
    chunkIndex: row.chunkIndex,
    content: row.content,
    tier: row.tier,
    pool: row.pool,
    importance: row.importance,
    tags: parseTags(row.tags),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    accessedAt: row.accessedAt,
  };
}

// tag serialization helpers moved to tag-serialization.ts
