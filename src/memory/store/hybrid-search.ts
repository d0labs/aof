import type { FtsSearchResult } from "./fts-store";
import type { VectorChunkRecord, VectorSearchResult } from "./vector-store";
import { FtsStore } from "./fts-store";
import { VectorStore } from "./vector-store";

export type MemoryTier = "hot" | "warm" | "cold";

export type HybridSearchConfig = {
  vectorWeight?: number;
  bm25Weight?: number;
  tierBoosts?: Partial<Record<MemoryTier, number>>;
  vectorLimitMultiplier?: number;
  bm25LimitMultiplier?: number;
};

export type HybridSearchQuery = {
  query: string;
  embedding: number[];
  limit: number;
};

export type HybridSearchResult = {
  chunkId: number;
  filePath: string;
  chunkIndex: number | null;
  content: string;
  tier: string | null;
  pool: string | null;
  importance: number | null;
  tags: string[] | null;
  score: number;
  vectorScore: number;
  bm25Score: number;
  distance?: number;
  bm25?: number;
};

type CombinedEntry = {
  chunkId: number;
  filePath: string | null;
  chunkIndex: number | null;
  content: string | null;
  tier: string | null;
  pool: string | null;
  importance: number | null;
  tags: string[] | null;
  vectorScore: number;
  bm25Score: number;
  distance?: number;
  bm25?: number;
};

const DEFAULT_TIER_BOOSTS: Record<MemoryTier, number> = {
  hot: 1,
  warm: 0.8,
  cold: 0.5,
};

const DEFAULT_WEIGHTS = {
  vector: 0.7,
  bm25: 0.3,
};

export class HybridSearchEngine {
  private readonly vectorStore: VectorStore;
  private readonly ftsStore: FtsStore;
  private readonly config: HybridSearchConfig;

  constructor(
    vectorStore: VectorStore,
    ftsStore: FtsStore,
    config: HybridSearchConfig = {}
  ) {
    this.vectorStore = vectorStore;
    this.ftsStore = ftsStore;
    this.config = config;
  }

  search(query: HybridSearchQuery): HybridSearchResult[] {
    if (query.limit <= 0) {
      return [];
    }

    const weights = normalizeWeights(
      this.config.vectorWeight,
      this.config.bm25Weight
    );
    const tierBoosts = {
      ...DEFAULT_TIER_BOOSTS,
      ...(this.config.tierBoosts ?? {}),
    };

    const vectorLimit = resolveLimit(
      query.limit,
      this.config.vectorLimitMultiplier
    );
    const bm25Limit = resolveLimit(
      query.limit,
      this.config.bm25LimitMultiplier
    );

    const vectorResults = this.vectorStore.search(query.embedding, vectorLimit);
    const ftsResults = this.ftsStore.search(query.query, bm25Limit);

    const combined = new Map<number, CombinedEntry>();
    vectorResults.forEach((result) =>
      addVectorResult(combined, result)
    );
    ftsResults.forEach((result) => addFtsResult(combined, result));

    hydrateMissingChunkData(combined, this.vectorStore);

    const ranked = Array.from(combined.values()).map((entry) => {
      const baseScore =
        weights.vector * entry.vectorScore +
        weights.bm25 * entry.bm25Score;
      const boost = tierBoosts[entry.tier as MemoryTier] ?? 1;
      const score = baseScore * boost;

      return {
        chunkId: entry.chunkId,
        filePath: entry.filePath ?? "",
        chunkIndex: entry.chunkIndex,
        content: entry.content ?? "",
        tier: entry.tier,
        pool: entry.pool,
        importance: entry.importance,
        tags: entry.tags,
        score,
        vectorScore: entry.vectorScore,
        bm25Score: entry.bm25Score,
        distance: entry.distance,
        bm25: entry.bm25,
      } satisfies HybridSearchResult;
    });

    return ranked
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit);
  }
}

function normalizeWeights(
  vectorWeight?: number,
  bm25Weight?: number
): { vector: number; bm25: number } {
  const vector = vectorWeight ?? DEFAULT_WEIGHTS.vector;
  const bm25 = bm25Weight ?? DEFAULT_WEIGHTS.bm25;
  const sum = vector + bm25;

  if (!Number.isFinite(sum) || sum <= 0) {
    return { ...DEFAULT_WEIGHTS };
  }

  return {
    vector: vector / sum,
    bm25: bm25 / sum,
  };
}

function resolveLimit(limit: number, multiplier?: number): number {
  const factor = multiplier ?? 2;
  if (!Number.isFinite(factor) || factor <= 1) {
    return limit;
  }

  return Math.max(limit, Math.ceil(limit * factor));
}

function addVectorResult(
  combined: Map<number, CombinedEntry>,
  result: VectorSearchResult
): void {
  const vectorScore = scoreVector(result.distance);

  combined.set(result.id, {
    chunkId: result.id,
    filePath: result.filePath,
    chunkIndex: result.chunkIndex,
    content: result.content,
    tier: result.tier,
    pool: result.pool,
    importance: result.importance,
    tags: result.tags,
    vectorScore,
    bm25Score: 0,
    distance: result.distance,
  });
}

function addFtsResult(
  combined: Map<number, CombinedEntry>,
  result: FtsSearchResult
): void {
  const bm25Score = scoreBm25(result.bm25);
  const existing = combined.get(result.chunkId);

  if (existing) {
    existing.bm25Score = bm25Score;
    existing.bm25 = result.bm25;
    existing.filePath = existing.filePath ?? result.filePath;
    existing.content = existing.content ?? result.content;
    existing.tags = existing.tags ?? result.tags;
    return;
  }

  combined.set(result.chunkId, {
    chunkId: result.chunkId,
    filePath: result.filePath,
    chunkIndex: null,
    content: result.content,
    tier: null,
    pool: null,
    importance: null,
    tags: result.tags,
    vectorScore: 0,
    bm25Score,
    bm25: result.bm25,
  });
}

function hydrateMissingChunkData(
  combined: Map<number, CombinedEntry>,
  vectorStore: VectorStore
): void {
  combined.forEach((entry) => {
    if (entry.chunkIndex !== null && entry.tier !== null) {
      return;
    }

    const chunk = vectorStore.getChunk(entry.chunkId);
    if (!chunk) {
      return;
    }

    entry.filePath = entry.filePath ?? chunk.filePath;
    entry.chunkIndex = entry.chunkIndex ?? chunk.chunkIndex;
    entry.content = entry.content ?? chunk.content;
    entry.tier = entry.tier ?? chunk.tier;
    entry.pool = entry.pool ?? chunk.pool;
    entry.importance = entry.importance ?? chunk.importance;
    entry.tags = entry.tags ?? chunk.tags;
  });
}

function scoreVector(distance: number): number {
  return 1 / (1 + Math.max(0, distance));
}

function scoreBm25(bm25: number): number {
  return 1 / (1 + Math.max(0, bm25));
}
