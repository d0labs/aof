import { readFile } from "node:fs/promises";

import type { OpenClawToolDefinition, ToolResult } from "../../openclaw/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { chunkMarkdown } from "../chunking/chunker.js";
import type { HybridSearchEngine, HybridSearchResult } from "../store/hybrid-search.js";
import type { Reranker } from "../store/reranker.js";
import { DEFAULT_TOP_K_BEFORE_RERANK } from "../store/reranker.js";

type MemorySearchParams = {
  query: string;
  maxResults?: number;
  minScore?: number;
  tiers?: string[];
  poolIds?: string[];
};

type MemorySearchToolOptions = {
  embeddingProvider: EmbeddingProvider;
  searchEngine: HybridSearchEngine;
  defaultMaxResults?: number;
  defaultMinScore?: number;
  /**
   * Optional cross-encoder reranker. When set, the search engine fetches
   * `topKBeforeRerank` candidates, the reranker scores them, then the final
   * `limit` results are returned.
   */
  reranker?: Reranker;
  /**
   * Candidate pool size passed to hybrid search when reranking is active.
   * Defaults to DEFAULT_TOP_K_BEFORE_RERANK (20).
   */
  topKBeforeRerank?: number;
};

type LineRange = {
  startLine: number;
  endLine: number;
};

const DEFAULT_MAX_RESULTS = 5;

const buildResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const normalizeStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];

const resolveLimit = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
};

const resolveMinScore = (value: unknown, fallback?: number): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return value;
};

const buildLineCache = () => new Map<string, ReturnType<typeof chunkMarkdown>>();

const loadChunks = async (
  filePath: string,
  cache: Map<string, ReturnType<typeof chunkMarkdown>>,
): Promise<ReturnType<typeof chunkMarkdown> | null> => {
  if (cache.has(filePath)) {
    return cache.get(filePath) ?? null;
  }

  try {
    const content = await readFile(filePath, "utf-8");
    const chunks = chunkMarkdown(content);
    cache.set(filePath, chunks);
    return chunks;
  } catch {
    cache.set(filePath, []);
    return null;
  }
};

const resolveLineRange = async (
  result: HybridSearchResult,
  cache: Map<string, ReturnType<typeof chunkMarkdown>>,
): Promise<LineRange | null> => {
  if (!result.filePath || result.chunkIndex === null) {
    return null;
  }

  const chunks = await loadChunks(result.filePath, cache);
  if (!chunks || chunks.length === 0) {
    return null;
  }

  const chunk = chunks[result.chunkIndex];
  if (!chunk) {
    return null;
  }

  return { startLine: chunk.startLine, endLine: chunk.endLine };
};

const formatResult = (
  index: number,
  result: HybridSearchResult,
  lineRange: LineRange | null,
): string => {
  const location = lineRange
    ? `${result.filePath}:${lineRange.startLine}-${lineRange.endLine}`
    : result.filePath || "(unknown path)";
  const score = result.score.toFixed(3);

  return `${index + 1}. ${location} (score: ${score})\n${result.content}`;
};

const filterResults = (
  results: HybridSearchResult[],
  tiers: string[],
  pools: string[],
  minScore?: number,
): HybridSearchResult[] => {
  return results.filter((result) => {
    if (tiers.length > 0 && (!result.tier || !tiers.includes(result.tier))) {
      return false;
    }

    if (pools.length > 0 && (!result.pool || !pools.includes(result.pool))) {
      return false;
    }

    if (typeof minScore === "number" && result.score < minScore) {
      return false;
    }

    return true;
  });
};

export const createMemorySearchTool = (
  options: MemorySearchToolOptions,
): OpenClawToolDefinition => {
  return {
    name: "memory_search",
    description: "Search memory files with hybrid vector + keyword search.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (required)",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return",
        },
        minScore: {
          type: "number",
          description: "Minimum relevance score to include",
        },
        tiers: {
          type: "array",
          items: { type: "string" },
          description: "Optional tier filter",
        },
        poolIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional pool filter",
        },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const { query } = params as MemorySearchParams;

      if (!query || !query.trim()) {
        return buildResult("Query is required.");
      }

      const limit = resolveLimit(
        params.maxResults,
        options.defaultMaxResults ?? DEFAULT_MAX_RESULTS,
      );
      const minScore = resolveMinScore(
        params.minScore,
        options.defaultMinScore,
      );
      const tiers = normalizeStringArray(params.tiers);
      const pools = normalizeStringArray(params.poolIds);

      const [embedding] = await options.embeddingProvider.embed([query.trim()]);
      if (!embedding || embedding.length === 0) {
        return buildResult("Embedding provider returned no vectors.");
      }

      // When reranking, fetch a larger candidate pool from hybrid search so
      // the cross-encoder can surface results that scored lower on vector/BM25.
      const candidateLimit = options.reranker
        ? Math.max(limit, options.topKBeforeRerank ?? DEFAULT_TOP_K_BEFORE_RERANK)
        : limit;

      const hybridResults = options.searchEngine.search({
        query,
        embedding,
        limit: candidateLimit,
      });

      const results = options.reranker
        ? await options.reranker.rerank(query, hybridResults)
        : hybridResults;

      const filtered = filterResults(results, tiers, pools, minScore).slice(
        0,
        limit,
      );

      if (filtered.length === 0) {
        return buildResult("No results found.");
      }

      const cache = buildLineCache();
      const formatted: string[] = [];

      for (const [index, result] of filtered.entries()) {
        const lineRange = await resolveLineRange(result, cache);
        formatted.push(formatResult(index, result, lineRange));
      }

      return buildResult(formatted.join("\n\n"));
    },
  };
};
