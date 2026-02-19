import { HierarchicalNSW } from "hnswlib-node";

/** A single KNN search result from the HNSW index. */
export type HnswSearchResult = {
  id: number;
  distance: number;
};

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
  private index: HierarchicalNSW;
  private readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
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
    const loaded = new HierarchicalNSW(DEFAULT_SPACE, this.dimensions);
    loaded.readIndexSync(filePath, true /* allowReplaceDeleted */);
    this.index = loaded;
  }

  // ─── Rebuild ─────────────────────────────────────────────────────────────

  /**
   * Replace the current index with one rebuilt from the provided chunks.
   * Use when the on-disk index is lost or corrupt.
   */
  rebuild(chunks: ReadonlyArray<{ id: number; embedding: number[] }>): void {
    const capacity = Math.max(chunks.length, INITIAL_CAPACITY);
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

  // ─── Private helpers ─────────────────────────────────────────────────────

  private createIndex(capacity: number): HierarchicalNSW {
    const idx = new HierarchicalNSW(DEFAULT_SPACE, this.dimensions);
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
      this.index.resizeIndex(max * GROWTH_FACTOR);
    }
  }
}
