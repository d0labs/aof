export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export type EmbeddingProviderConfig = {
  provider: "openai" | "ollama";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
};
