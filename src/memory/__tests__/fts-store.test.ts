import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initMemoryDb } from "../store/schema";
import { FtsStore } from "../store/fts-store";

const EMBEDDING_DIMENSIONS = 4;

describe("FtsStore", () => {
  let store: FtsStore;
  let db: ReturnType<typeof initMemoryDb>;

  beforeEach(() => {
    db = initMemoryDb(":memory:", EMBEDDING_DIMENSIONS);
    store = new FtsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("indexes chunks and returns BM25 matches", () => {
    store.insertChunk({
      chunkId: 1,
      content: "alpha beta",
      filePath: "alpha.md",
      tags: ["alpha"],
    });

    store.insertChunk({
      chunkId: 2,
      content: "gamma delta",
      filePath: "gamma.md",
      tags: ["gamma"],
    });

    const results = store.search("alpha", 5);

    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe(1);
    expect(results[0].tags).toEqual(["alpha"]);
    expect(results[0].bm25).toBeTypeOf("number");
  });

  it("deletes entries by file path", () => {
    store.insertChunk({
      chunkId: 1,
      content: "alpha beta",
      filePath: "alpha.md",
    });

    store.insertChunk({
      chunkId: 2,
      content: "alpha gamma",
      filePath: "alpha.md",
    });

    store.insertChunk({
      chunkId: 3,
      content: "delta",
      filePath: "delta.md",
    });

    const removed = store.deleteChunksByFile("alpha.md");
    const results = store.search("alpha", 5);

    expect(removed).toBe(2);
    expect(results).toHaveLength(0);
  });
});
