import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../embeddings/provider";
import { chunkMarkdown } from "../chunking/chunker";
import { HybridSearchEngine } from "../store/hybrid-search";
import { initMemoryDb } from "../store/schema";
import { FtsStore } from "../store/fts-store";
import { VectorStore } from "../store/vector-store";
import { createMemorySearchTool } from "../tools/search";

const EMBEDDING_DIMENSIONS = 4;

describe("memory_search tool", () => {
  let db: ReturnType<typeof initMemoryDb>;
  let vectorStore: VectorStore;
  let ftsStore: FtsStore;
  let searchEngine: HybridSearchEngine;
  let embeddingProvider: EmbeddingProvider;

  beforeEach(() => {
    db = initMemoryDb(":memory:", EMBEDDING_DIMENSIONS);
    vectorStore = new VectorStore(db);
    ftsStore = new FtsStore(db);
    searchEngine = new HybridSearchEngine(vectorStore, ftsStore);

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

  it("returns formatted results with line numbers", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-search-"));
    const filePath = path.join(dir, "alpha.md");
    const content = "alpha line 1\nalpha line 2\nalpha line 3";
    writeFileSync(filePath, content, "utf-8");

    const chunks = chunkMarkdown(content);
    const chunkId = vectorStore.insertChunk({
      filePath,
      chunkIndex: 0,
      content: chunks[0].content,
      embedding: [1, 0, 0, 0],
      tier: "hot",
      pool: "core",
    });

    ftsStore.insertChunk({
      chunkId,
      content: chunks[0].content,
      filePath,
      tags: ["alpha"],
    });

    const tool = createMemorySearchTool({
      embeddingProvider,
      searchEngine,
      defaultMaxResults: 3,
    });

    const result = await tool.execute("test", { query: "alpha" });
    const text = result.content[0].text;
    const expectedRange = `${filePath}:${chunks[0].startLine}-${chunks[0].endLine}`;

    expect(text).toContain(expectedRange);
    expect(text).toContain("alpha line 1");
  });

  it("filters results by tier and pool", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-search-filter-"));
    const hotPath = path.join(dir, "hot.md");
    const coldPath = path.join(dir, "cold.md");
    writeFileSync(hotPath, "alpha hot", "utf-8");
    writeFileSync(coldPath, "alpha cold", "utf-8");

    const hotChunks = chunkMarkdown("alpha hot");
    const coldChunks = chunkMarkdown("alpha cold");

    const hotId = vectorStore.insertChunk({
      filePath: hotPath,
      chunkIndex: 0,
      content: hotChunks[0].content,
      embedding: [1, 0, 0, 0],
      tier: "hot",
      pool: "core",
    });

    const coldId = vectorStore.insertChunk({
      filePath: coldPath,
      chunkIndex: 0,
      content: coldChunks[0].content,
      embedding: [1, 0, 0, 0],
      tier: "cold",
      pool: "archive",
    });

    ftsStore.insertChunk({ chunkId: hotId, content: hotChunks[0].content, filePath: hotPath });
    ftsStore.insertChunk({
      chunkId: coldId,
      content: coldChunks[0].content,
      filePath: coldPath,
    });

    const tool = createMemorySearchTool({
      embeddingProvider,
      searchEngine,
      defaultMaxResults: 3,
    });

    const result = await tool.execute("test", {
      query: "alpha",
      tiers: ["hot"],
      poolIds: ["core"],
    });

    const text = result.content[0].text;
    expect(text).toContain(hotPath);
    expect(text).not.toContain(coldPath);
  });

  it("returns a helpful message when no results match", async () => {
    const tool = createMemorySearchTool({
      embeddingProvider,
      searchEngine,
      defaultMaxResults: 3,
    });

    const result = await tool.execute("test", {
      query: "alpha",
      minScore: 2,
    });

    expect(result.content[0].text).toBe("No results found.");
  });
});
