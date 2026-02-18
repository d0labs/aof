import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { memoryGetTool } from "../tools/get";

describe("memory_get tool", () => {
  it("returns file contents with optional line ranges", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aof-memory-get-"));
    const filePath = path.join(dir, "note.md");
    writeFileSync(filePath, "line-1\nline-2\nline-3\nline-4", "utf-8");

    const full = await memoryGetTool.execute("test", { path: filePath });
    expect(full.content[0].text).toBe("line-1\nline-2\nline-3\nline-4");

    const slice = await memoryGetTool.execute("test", {
      path: filePath,
      from: 2,
      lines: 2,
    });
    expect(slice.content[0].text).toBe("line-2\nline-3");
  });

  it("handles missing files gracefully", async () => {
    const result = await memoryGetTool.execute("test", {
      path: "/missing/file.md",
    });

    expect(result.content[0].text).toBe("File not found: /missing/file.md");
  });
});
