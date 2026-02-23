/**
 * Tests for the file auditor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { auditFiles } from "../audit.js";

describe("auditFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-import-audit-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("absolute path that exists → existsOnDisk = true", async () => {
    const filePath = join(tmpDir, "MEMORY.md");
    await writeFile(filePath, "# memory");

    const results = await auditFiles([{ path: filePath, chunkCount: 3 }], tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0]!.existsOnDisk).toBe(true);
    expect(results[0]!.resolvedPath).toBe(filePath);
    expect(results[0]!.chunkCount).toBe(3);
  });

  it("absolute path that does NOT exist → existsOnDisk = false", async () => {
    const filePath = join(tmpDir, "missing.md");

    const results = await auditFiles([{ path: filePath, chunkCount: 1 }], tmpDir);

    expect(results[0]!.existsOnDisk).toBe(false);
  });

  it("relative path resolved against workspacePath → exists", async () => {
    const subDir = join(tmpDir, "sub");
    await mkdir(subDir);
    await writeFile(join(subDir, "notes.md"), "hello");

    const results = await auditFiles([{ path: "sub/notes.md", chunkCount: 2 }], tmpDir);

    expect(results[0]!.existsOnDisk).toBe(true);
    expect(results[0]!.resolvedPath).toBe(resolve(tmpDir, "sub/notes.md"));
  });

  it("relative path with ../ traversal resolves correctly", async () => {
    const base = join(tmpDir, "agents", "swe-suite", "workspace");
    const target = join(tmpDir, "workspace", "swe-process");
    await mkdir(base, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SDLC.md"), "# sdlc");

    // Simulate path stored as "../../../workspace/swe-process/SDLC.md" relative to base.
    const raw = "../../../workspace/swe-process/SDLC.md";
    const results = await auditFiles([{ path: raw, chunkCount: 5 }], base);

    expect(results[0]!.existsOnDisk).toBe(true);
    expect(results[0]!.rawPath).toBe(raw);
  });

  it("file not on disk → existsOnDisk = false, resolvedPath is canonical", async () => {
    const results = await auditFiles([{ path: "missing/file.md", chunkCount: 0 }], tmpDir);

    expect(results[0]!.existsOnDisk).toBe(false);
    expect(results[0]!.resolvedPath).toBe(resolve(tmpDir, "missing/file.md"));
  });

  it("preserves chunkCount in output", async () => {
    const filePath = join(tmpDir, "MEMORY.md");
    await writeFile(filePath, "# mem");

    const results = await auditFiles([{ path: filePath, chunkCount: 42 }], tmpDir);

    expect(results[0]!.chunkCount).toBe(42);
  });

  it("handles empty input", async () => {
    const results = await auditFiles([], tmpDir);
    expect(results).toEqual([]);
  });
});
