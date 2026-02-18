import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import matter from "gray-matter";
import type Database from "better-sqlite3";

import type { OpenClawToolDefinition, ToolResult } from "../../openclaw/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { chunkMarkdown } from "../chunking/chunker.js";
import { computeFileHash, updateFileRecord } from "../chunking/hash.js";
import type { FtsStore } from "../store/fts-store.js";
import type { VectorStore } from "../store/vector-store.js";

type MemoryStoreParams = {
  content: string;
  path?: string;
  pool?: string;
  tier?: string;
  tags?: string[];
  importance?: number;
};

type MemoryStoreToolOptions = {
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  ftsStore: FtsStore;
  db: Database;
  poolPaths: Record<string, string>;
  defaultPool?: string;
  defaultTier?: string;
};

type NormalizedMetadata = {
  pool?: string;
  tier?: string;
  tags?: string[];
  importance?: number;
};

const buildResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeContent = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const normalizeTags = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const tags = value.filter((tag) => typeof tag === "string" && tag.trim());
    return tags.length > 0 ? tags.map((tag) => tag.trim()) : undefined;
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return undefined;
};

const normalizeNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
};

const resolveMetadata = (
  params: MemoryStoreParams,
  frontmatter: Record<string, unknown>,
  defaultTier?: string,
  defaultPool?: string,
): NormalizedMetadata => {
  const tier = normalizeString(params.tier) ?? normalizeString(frontmatter.tier) ?? defaultTier;
  const pool = normalizeString(params.pool) ?? normalizeString(frontmatter.pool) ?? defaultPool;
  const tags = normalizeTags(params.tags) ?? normalizeTags(frontmatter.tags);
  const importance = normalizeNumber(params.importance) ?? normalizeNumber(frontmatter.importance);

  return { tier, pool, tags, importance };
};

const buildOutputContent = (
  bodyContent: string,
  frontmatter: Record<string, unknown>,
  metadata: NormalizedMetadata,
): { body: string; frontmatter: Record<string, unknown> } => {
  const merged = { ...frontmatter } as Record<string, unknown>;

  if (metadata.tier) merged.tier = metadata.tier;
  if (metadata.pool) merged.pool = metadata.pool;
  if (metadata.tags) merged.tags = metadata.tags;
  if (metadata.importance !== undefined) merged.importance = metadata.importance;

  return {
    body: matter.stringify(bodyContent, merged),
    frontmatter: merged,
  };
};

const resolvePoolPath = (
  pool: string | undefined,
  poolPaths: Record<string, string>,
): string | undefined => {
  if (!pool) {
    return undefined;
  }

  return poolPaths[pool];
};

const ensureDirectory = async (filePath: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
};

const generateFileName = (): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `memory-${timestamp}-${randomUUID()}.md`;
};

const resolveFilePath = (
  params: MemoryStoreParams,
  poolPath: string | undefined,
): string | null => {
  const requested = normalizeString(params.path);
  if (requested) {
    if (path.isAbsolute(requested)) {
      return requested;
    }

    if (!poolPath) {
      return null;
    }

    return path.join(poolPath, requested);
  }

  if (!poolPath) {
    return null;
  }

  return path.join(poolPath, generateFileName());
};

const indexChunks = async (
  options: MemoryStoreToolOptions,
  filePath: string,
  chunks: ReturnType<typeof chunkMarkdown>,
  metadata: NormalizedMetadata,
  hash: string,
): Promise<void> => {
  options.vectorStore.deleteChunksByFile(filePath);
  options.ftsStore.deleteChunksByFile(filePath);

  const embeddings = await options.embeddingProvider.embed(
    chunks.map((chunk) => chunk.content),
  );

  if (embeddings.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch (expected ${chunks.length}, got ${embeddings.length})`,
    );
  }

  chunks.forEach((chunk, index) => {
    const chunkId = options.vectorStore.insertChunk({
      filePath,
      chunkIndex: index,
      content: chunk.content,
      embedding: embeddings[index] ?? [],
      tier: metadata.tier,
      pool: metadata.pool,
      importance: metadata.importance ?? null,
      tags: metadata.tags ?? null,
    });

    options.ftsStore.insertChunk({
      chunkId,
      content: chunk.content,
      filePath,
      tags: metadata.tags ?? null,
    });
  });

  updateFileRecord(
    options.db,
    filePath,
    hash,
    chunks.length,
    metadata.tier,
    metadata.pool,
  );
};

export const createMemoryStoreTool = (
  options: MemoryStoreToolOptions,
): OpenClawToolDefinition => {
  return {
    name: "memory_store",
    description: "Store a memory entry, chunk it, embed it, and index it.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Markdown content to store (required)",
        },
        path: {
          type: "string",
          description: "Optional file path to write",
        },
        pool: {
          type: "string",
          description: "Optional pool identifier",
        },
        tier: {
          type: "string",
          description: "Optional tier (hot|warm|cold)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags",
        },
        importance: {
          type: "number",
          description: "Optional importance score",
        },
      },
      required: ["content"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const content = normalizeContent(params.content);
      if (!content || !content.trim()) {
        return buildResult("Content is required.");
      }

      const parsedParams = params as MemoryStoreParams;
      const parsed = matter(content);
      const metadata = resolveMetadata(
        parsedParams,
        parsed.data as Record<string, unknown>,
        options.defaultTier,
        options.defaultPool,
      );
      const poolPath = resolvePoolPath(metadata.pool, options.poolPaths);
      const filePath = resolveFilePath(parsedParams, poolPath);

      if (!filePath) {
        return buildResult("Pool path is required to resolve the memory file path.");
      }

      const output = buildOutputContent(
        parsed.content,
        parsed.data as Record<string, unknown>,
        metadata,
      );
      const chunks = chunkMarkdown(parsed.content);
      const hash = computeFileHash(output.body);

      await ensureDirectory(filePath);
      await writeFile(filePath, output.body, "utf-8");

      await indexChunks(options, filePath, chunks, metadata, hash);

      return buildResult(`Stored memory at ${filePath} (chunks: ${chunks.length}).`);
    },
  };
};
