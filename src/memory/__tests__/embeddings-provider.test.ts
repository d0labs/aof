import { describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../embeddings/provider";

describe("EmbeddingProvider", () => {
  it("embeds texts into vectors with expected dimensions", async () => {
    const provider: EmbeddingProvider = {
      embed: async (texts) => texts.map(() => [0, 1]),
      dimensions: 2,
    };

    const vectors = await provider.embed(["alpha", "beta"]);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([0, 1]);
    expect(provider.dimensions).toBe(2);
  });
});
