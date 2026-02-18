import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../embeddings/provider";
import { initMemoryDb } from "../store/schema";
import { FtsStore } from "../store/fts-store";
import { VectorStore } from "../store/vector-store";
import { createMemoryStoreTool } from "../tools/store";

const EMBEDDING_DIMENSIONS = 4;

describe("memory_store tool", () => {
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

  it("writes a file, chunks it, and indexes metadata", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-store-"));
    const poolPaths = { core: dir };

    const tool = createMemoryStoreTool({
      embeddingProvider,
      vectorStore,
      ftsStore,
      db,
      poolPaths,
      defaultPool: "core",
      defaultTier: "hot",
    });

    const result = await tool.execute("test", {
      content: "alpha line 1\nalpha line 2",
      tags: ["alpha"],
      importance: 0.8,
    });

    const text = result.content[0].text;
    const match = /Stored memory at (.*) \(chunks: (\d+)\)\./.exec(text);
    expect(match).not.toBeNull();

    const filePath = match?.[1] ?? "";
    const chunkCount = Number(match?.[2]);

    const fileContent = readFileSync(filePath, "utf-8");
    expect(fileContent).toContain("tier: hot");
    expect(fileContent).toContain("pool: core");
    expect(fileContent).toContain("tags:");
    expect(fileContent).toContain("- alpha");
    expect(fileContent).toContain("importance: 0.8");
    expect(fileContent).toContain("alpha line 1");

    const vectorResults = vectorStore.search([1, 0, 0, 0], 5);
    expect(vectorResults.length).toBeGreaterThan(0);

    const ftsResults = ftsStore.search("alpha", 5);
    expect(ftsResults.length).toBeGreaterThan(0);

    const fileRow = db
      .prepare("SELECT chunk_count as chunkCount FROM files WHERE path = ?")
      .get(filePath) as { chunkCount: number } | undefined;
    expect(fileRow?.chunkCount).toBe(chunkCount);
  });

  it("resolves relative paths inside the pool", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-store-path-"));
    const poolPaths = { core: dir };

    const tool = createMemoryStoreTool({
      embeddingProvider,
      vectorStore,
      ftsStore,
      db,
      poolPaths,
      defaultPool: "core",
    });

    const result = await tool.execute("test", {
      content: "alpha",
      path: "custom.md",
      pool: "core",
    });

    const text = result.content[0].text;
    const match = /Stored memory at (.*) \(chunks:/.exec(text);
    const filePath = match?.[1];

    expect(filePath).toBe(path.join(dir, "custom.md"));
  });
});
