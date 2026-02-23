/**
 * Tests for the orphan chunk writer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeOrphansToMemory } from "../writer.js";
import type { OrphanChunk } from "../types.js";

describe("writeOrphansToMemory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-import-writer-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes orphan chunks with correct markdown format", async () => {
    const target = join(tmpDir, "memory", "import-test.md");
    const orphans: OrphanChunk[] = [
      { chunkId: "c1", text: "This is memory content.", sourcePath: "gone.md" },
    ];

    const result = await writeOrphansToMemory(orphans, target);

    expect(result.written).toBe(1);
    expect(result.path).toBe(target);

    const content = await readFile(target, "utf-8");
    expect(content).toContain("## Imported memories (orphaned from: gone.md)");
    expect(content).toContain("This is memory content.");
    expect(content).toContain("<!-- Imported by aof memory import on");
    expect(content).toContain("---");
  });

  it("appends to an existing file without overwriting", async () => {
    const memDir = join(tmpDir, "memory");
    await mkdir(memDir, { recursive: true });
    const target = join(memDir, "import-test.md");

    await writeFile(target, "# Pre-existing content\n\n");

    const orphans: OrphanChunk[] = [
      { chunkId: "c1", text: "New memory.", sourcePath: "old-file.md" },
    ];

    await writeOrphansToMemory(orphans, target);

    const content = await readFile(target, "utf-8");
    expect(content).toContain("# Pre-existing content");
    expect(content).toContain("New memory.");
  });

  it("dry-run returns count without creating the file", async () => {
    const target = join(tmpDir, "memory", "dry-run.md");
    const orphans: OrphanChunk[] = [
      { chunkId: "c1", text: "Would be written.", sourcePath: "x.md" },
    ];

    const result = await writeOrphansToMemory(orphans, target, { dryRun: true });

    expect(result.written).toBe(1);
    await expect(readFile(target, "utf-8")).rejects.toThrow();
  });

  it("groups orphans from the same source path under one section header", async () => {
    const target = join(tmpDir, "memory", "grouped.md");
    const orphans: OrphanChunk[] = [
      { chunkId: "c1", text: "First chunk.", sourcePath: "shared.md" },
      { chunkId: "c2", text: "Second chunk.", sourcePath: "shared.md" },
    ];

    await writeOrphansToMemory(orphans, target);

    const content = await readFile(target, "utf-8");
    const headerCount = (content.match(/## Imported memories \(orphaned from: shared\.md\)/g) ?? []).length;
    expect(headerCount).toBe(1);
    expect(content).toContain("First chunk.");
    expect(content).toContain("Second chunk.");
  });

  it("groups orphans from different source paths under separate headers", async () => {
    const target = join(tmpDir, "memory", "multi.md");
    const orphans: OrphanChunk[] = [
      { chunkId: "c1", text: "From A.", sourcePath: "a.md" },
      { chunkId: "c2", text: "From B.", sourcePath: "b.md" },
    ];

    await writeOrphansToMemory(orphans, target);

    const content = await readFile(target, "utf-8");
    expect(content).toContain("## Imported memories (orphaned from: a.md)");
    expect(content).toContain("## Imported memories (orphaned from: b.md)");
  });

  it("returns written=0 and does nothing for empty orphan list", async () => {
    const target = join(tmpDir, "memory", "empty.md");
    const result = await writeOrphansToMemory([], target);

    expect(result.written).toBe(0);
    await expect(readFile(target, "utf-8")).rejects.toThrow(); // file not created
  });

  it("creates parent directories automatically", async () => {
    const target = join(tmpDir, "deep", "nested", "dir", "import.md");
    const orphans: OrphanChunk[] = [
      { chunkId: "c1", text: "Deep content.", sourcePath: "x.md" },
    ];

    const result = await writeOrphansToMemory(orphans, target);
    expect(result.written).toBe(1);
    const content = await readFile(target, "utf-8");
    expect(content).toContain("Deep content.");
  });
});
