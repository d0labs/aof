import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FtsStore } from "../store/fts-store";
import { HybridSearchEngine } from "../store/hybrid-search";
import { initMemoryDb } from "../store/schema";
import { VectorStore } from "../store/vector-store";

const EMBEDDING_DIMENSIONS = 4;

describe("HybridSearchEngine", () => {
  let db: ReturnType<typeof initMemoryDb>;
  let vectorStore: VectorStore;
  let ftsStore: FtsStore;
  let engine: HybridSearchEngine;

  beforeEach(() => {
    db = initMemoryDb(":memory:", EMBEDDING_DIMENSIONS);
    vectorStore = new VectorStore(db);
    ftsStore = new FtsStore(db);
    engine = new HybridSearchEngine(vectorStore, ftsStore);
  });

  afterEach(() => {
    db.close();
  });

  it("combines vector and BM25 scores with tier boosts", () => {
    const embedding = [0.1, 0.1, 0.1, 0.1];

    const hotId = vectorStore.insertChunk({
      filePath: "alpha.md",
      chunkIndex: 0,
      content: "alpha",
      embedding,
      tier: "hot",
    });

    const coldId = vectorStore.insertChunk({
      filePath: "alpha.md",
      chunkIndex: 1,
      content: "alpha",
      embedding,
      tier: "cold",
    });

    ftsStore.insertChunk({
      chunkId: hotId,
      content: "alpha",
      filePath: "alpha.md",
    });

    ftsStore.insertChunk({
      chunkId: coldId,
      content: "alpha",
      filePath: "alpha.md",
    });

    const results = engine.search({
      query: "alpha",
      embedding,
      limit: 2,
    });

    expect(results).toHaveLength(2);
    expect(results[0].chunkId).toBe(hotId);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
