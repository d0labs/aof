import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "../chunking/chunker";

describe("chunkMarkdown", () => {
  it("splits on headings and tracks line ranges", () => {
    const content = [
      "## Alpha",
      "First paragraph line.",
      "Second line.",
      "",
      "### Beta",
      "Another paragraph.",
    ].join("\n");

    const chunks = chunkMarkdown(content, { maxChunkSize: 2000, overlap: 1 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({
      content: "## Alpha\n\nFirst paragraph line.\nSecond line.",
      startLine: 1,
      endLine: 3,
      headings: ["Alpha"],
    });
    expect(chunks[1]).toEqual({
      content: "### Beta\n\nAnother paragraph.",
      startLine: 5,
      endLine: 6,
      headings: ["Alpha", "Beta"],
    });
  });

  it("overlaps the last paragraph when splitting by size", () => {
    const content = [
      "Paragraph one.",
      "",
      "Paragraph two.",
      "",
      "Paragraph three.",
    ].join("\n");

    const chunks = chunkMarkdown(content, { maxChunkSize: 30, overlap: 1 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe("Paragraph one.\n\nParagraph two.");
    expect(chunks[1].content).toBe("Paragraph two.\n\nParagraph three.");
    expect(chunks[1].startLine).toBe(3);
  });
});
