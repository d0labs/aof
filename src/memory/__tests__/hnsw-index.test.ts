import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HnswIndex } from "../store/hnsw-index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DIMS = 8;

function randomVector(dims: number = DIMS): number[] {
  return Array.from({ length: dims }, () => Math.random());
}

function makeIndex(dims: number = DIMS): HnswIndex {
  return new HnswIndex(dims);
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("HnswIndex", () => {
  // ─── Insert + search ────────────────────────────────────────────────────

  describe("insert and search", () => {
    it("returns the nearest inserted vector for a query equal to it", () => {
      const idx = makeIndex();
      const target = [1, 0, 0, 0, 0, 0, 0, 0];
      const far = [0, 0, 0, 0, 0, 0, 0, 1];

      idx.add(1, target);
      idx.add(2, far);

      const results = idx.search(target, 1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
      expect(results[0].distance).toBeCloseTo(0, 4);
    });

    it("returns results ordered by ascending distance", () => {
      const idx = makeIndex();
      const query = [1, 0, 0, 0, 0, 0, 0, 0];

      idx.add(10, [1, 0, 0, 0, 0, 0, 0, 0]); // closest
      idx.add(20, [0.7, 0.7, 0, 0, 0, 0, 0, 0]); // middle
      idx.add(30, [0, 0, 0, 0, 0, 0, 0, 1]); // farthest

      const results = idx.search(query, 3);
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe(10);
      expect(results[0].distance).toBeLessThanOrEqual(results[1].distance);
      expect(results[1].distance).toBeLessThanOrEqual(results[2].distance);
    });

    it("returns empty array when index is empty", () => {
      const idx = makeIndex();
      expect(idx.search(randomVector(), 5)).toEqual([]);
    });

    it("caps results at available count when k > index size", () => {
      const idx = makeIndex();
      idx.add(1, randomVector());
      idx.add(2, randomVector());

      const results = idx.search(randomVector(), 100);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("exposes correct count after inserts", () => {
      const idx = makeIndex();
      expect(idx.count).toBe(0);
      idx.add(1, randomVector());
      idx.add(2, randomVector());
      expect(idx.count).toBe(2);
    });
  });

  // ─── Delete ─────────────────────────────────────────────────────────────

  describe("remove", () => {
    it("removed ID does not appear in search results", () => {
      const idx = makeIndex();
      const target = [1, 0, 0, 0, 0, 0, 0, 0];

      idx.add(1, target);
      idx.add(2, [0, 0, 0, 0, 0, 0, 0, 1]);

      idx.remove(1);

      const results = idx.search(target, 2);
      const ids = results.map((r) => r.id);
      expect(ids).not.toContain(1);
    });

    it("silently ignores remove of non-existent label", () => {
      const idx = makeIndex();
      expect(() => idx.remove(999)).not.toThrow();
    });
  });

  // ─── Update ─────────────────────────────────────────────────────────────

  describe("update", () => {
    it("updated vector replaces old vector in search", () => {
      const idx = makeIndex();
      const originalVec = [1, 0, 0, 0, 0, 0, 0, 0];
      const newVec = [0, 0, 0, 0, 0, 0, 0, 1];

      idx.add(1, originalVec);
      idx.update(1, newVec);

      const results = idx.search(newVec, 1);
      expect(results[0].id).toBe(1);
    });
  });

  // ─── Persistence ────────────────────────────────────────────────────────

  describe("persistence (save/load)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "hnsw-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("round-trips index through disk", () => {
      const idx = makeIndex();
      const target = [1, 0, 0, 0, 0, 0, 0, 0];

      idx.add(1, target);
      idx.add(2, [0, 0, 0, 0, 0, 0, 0, 1]);

      const filePath = join(tmpDir, "test.dat");
      idx.save(filePath);

      const loaded = makeIndex();
      loaded.load(filePath);

      const results = loaded.search(target, 1);
      expect(results[0].id).toBe(1);
    });

    it("loaded index preserves search accuracy", () => {
      const idx = makeIndex();
      const vectors: Array<[number, number[]]> = [
        [1, [1, 0, 0, 0, 0, 0, 0, 0]],
        [2, [0, 1, 0, 0, 0, 0, 0, 0]],
        [3, [0, 0, 1, 0, 0, 0, 0, 0]],
      ];

      for (const [id, vec] of vectors) {
        idx.add(id, vec);
      }

      const filePath = join(tmpDir, "multi.dat");
      idx.save(filePath);

      const loaded = makeIndex();
      loaded.load(filePath);

      const results = loaded.search([1, 0, 0, 0, 0, 0, 0, 0], 1);
      expect(results[0].id).toBe(1);
    });
  });

  // ─── Rebuild ────────────────────────────────────────────────────────────

  describe("rebuild", () => {
    it("rebuilds index from provided chunks", () => {
      const idx = makeIndex();
      const target = [1, 0, 0, 0, 0, 0, 0, 0];

      idx.rebuild([
        { id: 1, embedding: target },
        { id: 2, embedding: [0, 0, 0, 0, 0, 0, 0, 1] },
      ]);

      const results = idx.search(target, 1);
      expect(results[0].id).toBe(1);
    });

    it("replacing corrupt index via rebuild restores search", () => {
      const idx = makeIndex();
      idx.add(99, [1, 0, 0, 0, 0, 0, 0, 0]);

      // Simulate corruption by rebuilding with fresh data
      idx.rebuild([{ id: 5, embedding: [1, 0, 0, 0, 0, 0, 0, 0] }]);

      const results = idx.search([1, 0, 0, 0, 0, 0, 0, 0], 5);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(5);
      expect(ids).not.toContain(99);
    });

    it("rebuild with empty chunks produces empty index", () => {
      const idx = makeIndex();
      idx.add(1, randomVector());
      idx.rebuild([]);
      expect(idx.search(randomVector(), 5)).toEqual([]);
    });
  });

  // ─── Benchmark: P99 < 100ms at 10k vectors ──────────────────────────────

  describe("performance", () => {
    it("P99 search latency < 100ms at 10k vectors", () => {
      const DIMS_BENCH = 128; // large enough to stress ANN, fast enough to build
      const N = 10_000;
      const SAMPLES = 200;

      const idx = new HnswIndex(DIMS_BENCH);
      const vectors: number[][] = [];

      for (let i = 0; i < N; i++) {
        const v = Array.from({ length: DIMS_BENCH }, () => Math.random());
        vectors.push(v);
        idx.add(i, v);
      }

      // Warm up
      for (let i = 0; i < 10; i++) {
        idx.search(vectors[i], 10);
      }

      // Measure
      const latencies: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const query = vectors[Math.floor(Math.random() * N)];
        const t0 = performance.now();
        idx.search(query, 10);
        latencies.push(performance.now() - t0);
      }

      latencies.sort((a, b) => a - b);
      const p99 = latencies[Math.floor(SAMPLES * 0.99)];

      expect(p99).toBeLessThan(100);
    }, 30_000 /* 30s timeout for index build + search */);
  });
});
