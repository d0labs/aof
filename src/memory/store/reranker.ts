/**
 * Cross-encoder reranker for memory search results.
 *
 * Runs fully locally via ONNX (no API calls). Uses @huggingface/transformers
 * as an optional dependency — if not installed or not configured, reranking is
 * a transparent no-op.
 *
 * Recommended model: Xenova/ms-marco-MiniLM-L-6-v2 (~22 MB quantized ONNX).
 * Lighter alternative: Xenova/ms-marco-MiniLM-L-2-v2 (~8 MB, faster on RPi).
 */

import type { HybridSearchResult } from "./hybrid-search.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type RerankerConfig = {
  /** Enable the reranking step. Default: false. */
  enabled: boolean;
  /**
   * HuggingFace model ID or absolute path to a local model directory.
   * Must be an ONNX-compatible cross-encoder (seq-classification).
   * Default: "Xenova/ms-marco-MiniLM-L-6-v2"
   */
  modelPath?: string;
  /**
   * Number of candidates to pull from hybrid search before reranking.
   * More candidates → better recall but slower reranking.
   * Default: 20.
   */
  topKBeforeRerank?: number;
};

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Reranker {
  /**
   * Rerank hybrid search results for the given query.
   * Returns the same result objects with updated `score` fields, sorted
   * descending by relevance. Inputs are never mutated.
   */
  rerank(
    query: string,
    results: HybridSearchResult[]
  ): Promise<HybridSearchResult[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
export const DEFAULT_TOP_K_BEFORE_RERANK = 20;

// ---------------------------------------------------------------------------
// CrossEncoderReranker
// ---------------------------------------------------------------------------

/**
 * Local cross-encoder reranker backed by @huggingface/transformers (ONNX).
 *
 * Lazy-loads the model on first use. Thread-safe: concurrent calls to
 * `rerank()` share a single load promise.
 */
export class CrossEncoderReranker implements Reranker {
  private readonly modelPath: string;
  private loadPromise: Promise<void> | null = null;

  // These are typed as unknown to avoid importing the heavy HF types at
  // module-load time. They are only populated after the first rerank call.
  private tokenizer: unknown = null;
  private model: unknown = null;

  constructor(modelPath: string = DEFAULT_RERANKER_MODEL) {
    this.modelPath = modelPath;
  }

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  async rerank(
    query: string,
    results: HybridSearchResult[]
  ): Promise<HybridSearchResult[]> {
    if (results.length === 0) return results;

    await this.ensureLoaded();

    const logits = await this.score(query, results);

    return results
      .map((result, i) => ({
        ...result,
        score: sigmoid(logits[i] ?? 0),
      }))
      .sort((a, b) => b.score - a.score);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise !== null) return this.loadPromise;

    this.loadPromise = (async () => {
      let transforms: {
        AutoTokenizer: { from_pretrained(id: string): Promise<unknown> };
        AutoModelForSequenceClassification: {
          from_pretrained(id: string): Promise<unknown>;
        };
      };

      try {
        transforms = (await import(
          "@huggingface/transformers"
        )) as typeof transforms;
      } catch {
        throw new Error(
          "Reranker requires @huggingface/transformers — " +
            "install it with: npm install @huggingface/transformers"
        );
      }

      const [tokenizer, model] = await Promise.all([
        transforms.AutoTokenizer.from_pretrained(this.modelPath),
        transforms.AutoModelForSequenceClassification.from_pretrained(
          this.modelPath
        ),
      ]);

      this.tokenizer = tokenizer;
      this.model = model;
    })();

    return this.loadPromise;
  }

  private async score(
    query: string,
    results: HybridSearchResult[]
  ): Promise<number[]> {
    const queries = Array<string>(results.length).fill(query);
    const passages = results.map((r) => r.content);

    // Tokenize all query–passage pairs in a single batched call.
    const features = (
      this.tokenizer as (
        q: string[],
        opts: {
          text_pair: string[];
          padding: boolean;
          truncation: boolean;
        }
      ) => unknown
    )(queries, {
      text_pair: passages,
      padding: true,
      truncation: true,
    });

    const output = (await (this.model as (f: unknown) => Promise<{
      logits: { data: ArrayLike<number>; dims: number[] };
    }>)(features)) as { logits: { data: ArrayLike<number>; dims: number[] } };

    // logits is a flat Float32Array.
    // Shape is [n, 1] for single-label classifiers, so stride = 1.
    return Array.from(output.logits.data) as number[];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a reranker from config, or return null if disabled.
 * Always returns null when `config.enabled` is false — callers can safely
 * skip reranking without branching on undefined.
 */
export function createReranker(config: RerankerConfig): Reranker | null {
  if (!config.enabled) return null;

  return new CrossEncoderReranker(
    config.modelPath ?? DEFAULT_RERANKER_MODEL
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sigmoid squashes logits to (0, 1) while preserving ranking order. */
function sigmoid(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}
