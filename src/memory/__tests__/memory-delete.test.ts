import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../embeddings/provider";
import { initMemoryDb } from "../store/schema";
import { FtsStore } from "../store/fts-store";
import { VectorStore } from "../store/vector-store";
import { createMemoryDeleteTool } from "../tools/delete";
import { createMemoryStoreTool } from "../tools/store";

const EMBEDDING_DIMENSIONS = 4;

describe("memory_delete tool", () => {
  let db: ReturnType<typeof initMemoryDb>;
  let vectorStore: VectorStore;
  let ftsStore: FtsStore;
  let embeddingProvider: EmbeddingProvider;

  beforeEach(() => {
    db = initMemoryDb(":memory:", EMBEDDING_DIMENSIONS);
    vectorStore = new VectorStore(db);
    ftsStore = new FtsStore(db);

    embeddingProvider = {
      dimensions: EMBEDDING_DIMENSIONS,
      embed: async (texts: string[]) =>
        texts.map((text) =>
          text.includes("alpha") ? [1, 0, 0, 0] : [0, 1, 0, 0],
        ),
    };
  });

  afterEach(() => {
    db.close();
  });

  it("deletes the file and clears indexes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-delete-"));
    const poolPaths = { core: dir };

    const storeTool = createMemoryStoreTool({
      embeddingProvider,
      vectorStore,
      ftsStore,
      db,
      poolPaths,
      defaultPool: "core",
    });

    const storeResult = await storeTool.execute("test", {
      content: "alpha line 1",
      pool: "core",
    });

    const match = /Stored memory at (.*) \(chunks:/.exec(
      storeResult.content[0].text,
    );
    const filePath = match?.[1] ?? "";

    const deleteTool = createMemoryDeleteTool({ vectorStore, ftsStore, db });
    const deleteResult = await deleteTool.execute("test", { path: filePath });

    expect(deleteResult.content[0].text).toContain("Deleted memory file");
    expect(existsSync(filePath)).toBe(false);

    expect(vectorStore.search([1, 0, 0, 0], 5)).toHaveLength(0);
    expect(ftsStore.search("alpha", 5)).toHaveLength(0);
  });

  it("reports missing files while clearing indexes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-delete-missing-"));
    const poolPaths = { core: dir };

    const storeTool = createMemoryStoreTool({
      embeddingProvider,
      vectorStore,
      ftsStore,
      db,
      poolPaths,
      defaultPool: "core",
    });

    const storeResult = await storeTool.execute("test", {
      content: "alpha line 1",
      pool: "core",
    });

    const match = /Stored memory at (.*) \(chunks:/.exec(
      storeResult.content[0].text,
    );
    const filePath = match?.[1] ?? "";

    unlinkSync(filePath);

    const deleteTool = createMemoryDeleteTool({ vectorStore, ftsStore, db });
    const deleteResult = await deleteTool.execute("test", { path: filePath });

    expect(deleteResult.content[0].text).toContain("File not found");
    expect(vectorStore.search([1, 0, 0, 0], 5)).toHaveLength(0);
    expect(ftsStore.search("alpha", 5)).toHaveLength(0);
  });
});
