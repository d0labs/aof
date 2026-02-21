import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HybridSearchResult } from "../store/hybrid-search";
import {
  CrossEncoderReranker,
  DEFAULT_RERANKER_MODEL,
  DEFAULT_TOP_K_BEFORE_RERANK,
  createReranker,
} from "../store/reranker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeResult = (
  id: number,
  content: string,
  score = 0.5
): HybridSearchResult => ({
  chunkId: id,
  filePath: `file${id}.md`,
  chunkIndex: 0,
  content,
  tier: "hot",
  pool: "core",
  importance: null,
  tags: null,
  score,
  vectorScore: score,
  bm25Score: score,
});

// Logit values chosen so that result ordering is deterministic.
// Positive logit → sigmoid > 0.5; negative → sigmoid < 0.5.
const buildFakeTransformers = (logits: number[]) => ({
  AutoTokenizer: {
    from_pretrained: vi.fn().mockResolvedValue({
      // Fake tokenizer — returns an opaque object (not inspected by tests)
      __tokenizer: true,
    }),
  },
  AutoModelForSequenceClassification: {
    from_pretrained: vi.fn().mockResolvedValue({
      // Fake model — returns logits wrapped in a tensor-like object
      __model: true,
    }),
  },
  // The actual tokenizer call is not exercised through the mock; we stub
  // the model invocation at the reranker level via a subclass.
  __logits: logits,
});

// ---------------------------------------------------------------------------
// Unit: createReranker factory
// ---------------------------------------------------------------------------

describe("createReranker", () => {
  it("returns null when disabled", () => {
    const result = createReranker({ enabled: false });
    expect(result).toBeNull();
  });

  it("returns null when enabled is false even with modelPath set", () => {
    const result = createReranker({
      enabled: false,
      modelPath: "/some/model",
    });
    expect(result).toBeNull();
  });

  it("returns a CrossEncoderReranker when enabled", () => {
    const result = createReranker({ enabled: true });
    expect(result).toBeInstanceOf(CrossEncoderReranker);
  });

  it("uses DEFAULT_RERANKER_MODEL when no modelPath given", () => {
    const reranker = createReranker({ enabled: true }) as CrossEncoderReranker;
    // Access internal state via a type-cast to test default model path
    expect((reranker as unknown as { modelPath: string }).modelPath).toBe(
      DEFAULT_RERANKER_MODEL
    );
  });

  it("uses provided modelPath", () => {
    const reranker = createReranker({
      enabled: true,
      modelPath: "/my/local/model",
    }) as CrossEncoderReranker;
    expect((reranker as unknown as { modelPath: string }).modelPath).toBe(
      "/my/local/model"
    );
  });
});

// ---------------------------------------------------------------------------
// Unit: defaults
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEFAULT_RERANKER_MODEL is the expected HF model ID", () => {
    expect(DEFAULT_RERANKER_MODEL).toBe("Xenova/ms-marco-MiniLM-L-6-v2");
  });

  it("DEFAULT_TOP_K_BEFORE_RERANK is 20", () => {
    expect(DEFAULT_TOP_K_BEFORE_RERANK).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Unit: CrossEncoderReranker (with mocked @huggingface/transformers)
// ---------------------------------------------------------------------------

describe("CrossEncoderReranker", () => {
  let mockLogits: number[];

  // We override the private `score()` method to avoid actually loading the
  // @huggingface/transformers package during unit tests.
  const buildTestReranker = (logits: number[]) => {
    mockLogits = logits;
    const reranker = new CrossEncoderReranker("/fake/model");

    // Monkey-patch the private method to return the fake logits.
    // This is intentional test-only coupling on the implementation detail
    // that score() returns per-document logits.
    Object.defineProperty(reranker, "ensureLoaded", {
      value: async () => {},
      writable: true,
    });
    Object.defineProperty(reranker, "score", {
      value: async (_query: string, results: HybridSearchResult[]) =>
        results.map((_, i) => mockLogits[i] ?? 0),
      writable: true,
    });

    return reranker;
  };

  it("returns empty array when no results provided", async () => {
    const reranker = buildTestReranker([]);
    const out = await reranker.rerank("query", []);
    expect(out).toEqual([]);
  });

  it("sorts results by logit descending", async () => {
    const results = [
      makeResult(1, "low relevance"),
      makeResult(2, "high relevance"),
      makeResult(3, "medium relevance"),
    ];
    // logits: result[0]=1, result[1]=10, result[2]=5
    const reranker = buildTestReranker([1, 10, 5]);
    const out = await reranker.rerank("test query", results);

    expect(out.map((r) => r.chunkId)).toEqual([2, 3, 1]);
  });

  it("applies sigmoid to logits, producing scores in (0, 1)", async () => {
    const results = [makeResult(1, "doc A"), makeResult(2, "doc B")];
    const reranker = buildTestReranker([8.66, -11.25]);
    const out = await reranker.rerank("query", results);

    // sigmoid(8.66) ≈ 0.9998; sigmoid(-11.25) ≈ 0.000013
    expect(out[0].score).toBeGreaterThan(0.99);
    expect(out[1].score).toBeLessThan(0.01);
    // All scores must be strictly in (0, 1)
    for (const r of out) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(1);
    }
  });

  it("does not mutate the original result objects", async () => {
    const results = [makeResult(1, "doc", 0.9)];
    const original = { ...results[0] };
    const reranker = buildTestReranker([2]);

    await reranker.rerank("query", results);

    expect(results[0].score).toBe(original.score); // original unchanged
  });

  it("preserves all HybridSearchResult fields in output", async () => {
    const r = makeResult(42, "content", 0.7);
    r.tags = ["tag1"];
    const reranker = buildTestReranker([3]);

    const [out] = await reranker.rerank("q", [r]);

    expect(out.chunkId).toBe(42);
    expect(out.filePath).toBe("file42.md");
    expect(out.content).toBe("content");
    expect(out.tags).toEqual(["tag1"]);
  });

  it("handles a single result without errors", async () => {
    const reranker = buildTestReranker([5]);
    const out = await reranker.rerank("q", [makeResult(1, "only doc")]);
    expect(out).toHaveLength(1);
    expect(out[0].chunkId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit: error handling when @huggingface/transformers is missing
// ---------------------------------------------------------------------------

describe("CrossEncoderReranker load error", () => {
  it("throws a descriptive error if @huggingface/transformers is not installed", async () => {
    const reranker = new CrossEncoderReranker("/fake/model");

    // Patch ensureLoaded to simulate a missing module
    Object.defineProperty(reranker, "ensureLoaded", {
      value: async () => {
        throw new Error(
          "Reranker requires @huggingface/transformers — " +
            "install it with: npm install @huggingface/transformers"
        );
      },
    });

    await expect(
      reranker.rerank("query", [makeResult(1, "doc")])
    ).rejects.toThrow("@huggingface/transformers");
  });
});
