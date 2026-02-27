import hnswlib from "hnswlib-node";
import type { HierarchicalNSW as HierarchicalNSWType } from "hnswlib-node";
const { HierarchicalNSW } = hnswlib;

/** A single KNN search result from the HNSW index. */
export type HnswSearchResult = {
  id: number;
  distance: number;
};

/** Optional callback for logging resize events (wired from VectorStore). */
export type ResizeEventLogger = (event: {
  type: "memory.index.resized";
  oldCapacity: number;
  newCapacity: number;
  currentCount: number;
}) => void;

const INITIAL_CAPACITY = 10_000;
const GROWTH_FACTOR = 2;
const DEFAULT_SPACE = "cosine" as const;

/**
 * Thin wrapper around HierarchicalNSW that provides:
 * - Incremental inserts with automatic capacity growth
 * - markDelete-based removal (no full rebuild on delete)
 * - Disk persistence (save/load)
 * - Rebuild from arbitrary {id, embedding} pairs
 *
 * Labels in the HNSW index map 1-to-1 to sqlite chunk IDs.
 */
export class HnswIndex {
  private index: HierarchicalNSWType;
  private readonly _dimensions: number;
  private readonly onResize: ResizeEventLogger | null;

  constructor(dimensions: number, onResize?: ResizeEventLogger) {
    this._dimensions = dimensions;
    this.onResize = onResize ?? null;
    this.index = this.createIndex(INITIAL_CAPACITY);
  }

  // ─── Mutation ────────────────────────────────────────────────────────────

  /** Add a vector with the given integer label (chunk ID). Grows capacity if needed. */
  add(id: number, vector: number[]): void {
    this.ensureCapacity();
    this.index.addPoint(vector, id);
  }

  /**
   * Update the vector for an existing label.
   * Marks the old entry deleted then inserts the new vector under the same label.
   */
  update(id: number, vector: number[]): void {
    try {
      this.index.markDelete(id);
    } catch {
      // Label may not exist (e.g. after a rebuild gap) — proceed with insert
    }
    this.ensureCapacity();
    this.index.addPoint(vector, id, true /* replaceDeleted */);
  }

  /** Mark a label as deleted. It will no longer appear in search results. */
  remove(id: number): void {
    try {
      this.index.markDelete(id);
    } catch {
      // Label not present — silently ignore
    }
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  /** Return up to `k` nearest neighbours ordered by distance (ascending). */
  search(vector: number[], k: number): HnswSearchResult[] {
    const liveCount = this.index.getCurrentCount();
    if (liveCount === 0) return [];

    const numNeighbors = Math.min(k, liveCount);
    const result = this.index.searchKnn(vector, numNeighbors);

    return result.neighbors.map((id, i) => ({
      id,
      distance: result.distances[i] ?? 0,
    }));
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /** Persist the index to disk synchronously. */
  save(filePath: string): void {
    this.index.writeIndexSync(filePath);
  }

  /** Load an index from disk synchronously, replacing the current index. */
  load(filePath: string): void {
    const loaded = new HierarchicalNSW(DEFAULT_SPACE, this._dimensions);
    loaded.readIndexSync(filePath, true /* allowReplaceDeleted */);
    this.index = loaded;
  }

  // ─── Rebuild ─────────────────────────────────────────────────────────────

  /**
   * Replace the current index with one rebuilt from the provided chunks.
   * Uses 1.5x headroom to avoid immediate resize after rebuild.
   */
  rebuild(chunks: ReadonlyArray<{ id: number; embedding: number[] }>): void {
    const capacity = Math.max(Math.ceil(chunks.length * 1.5), INITIAL_CAPACITY);
    const fresh = this.createIndex(capacity);
    for (const { id, embedding } of chunks) {
      fresh.addPoint(embedding, id);
    }
    this.index = fresh;
  }

  // ─── Introspection ───────────────────────────────────────────────────────

  /** Number of live (non-deleted) elements in the index. */
  get count(): number {
    return this.index.getCurrentCount();
  }

  /** Maximum number of elements the index can hold before needing a resize. */
  get maxElements(): number {
    return this.index.getMaxElements();
  }

  /** Number of embedding dimensions. */
  get dimensions(): number {
    return this._dimensions;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private createIndex(capacity: number): HierarchicalNSWType {
    const idx = new HierarchicalNSW(DEFAULT_SPACE, this._dimensions);
    idx.initIndex({
      maxElements: capacity,
      allowReplaceDeleted: true,
    });
    return idx;
  }

  private ensureCapacity(): void {
    const count = this.index.getCurrentCount();
    const max = this.index.getMaxElements();
    if (count >= max) {
      const newCapacity = max * GROWTH_FACTOR;
      this.index.resizeIndex(newCapacity);

      if (this.onResize) {
        this.onResize({
          type: "memory.index.resized",
          oldCapacity: max,
          newCapacity,
          currentCount: count,
        });
      }
    }
  }
}
