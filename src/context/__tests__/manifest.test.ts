/**
 * Context Manifest Tests
 * 
 * Tests manifest loading, saving, and generation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { loadManifest, saveManifest, generateDefaultManifest } from "../manifest.js";
import type { ContextManifest } from "../assembler.js";

describe("Context Manifest", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-manifest-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("loadManifest()", () => {
    it("returns null when manifest file does not exist", async () => {
      const task = await store.create({
        title: "Task without manifest",
        body: "No manifest file",
        createdBy: "test",
      });

      const manifest = await loadManifest(task.frontmatter.id, store);
      expect(manifest).toBeNull();
    });

    it("loads and parses manifest from inputs/context-manifest.json", async () => {
      const task = await store.create({
        title: "Task with manifest",
        body: "Has manifest file",
        createdBy: "test",
      });

      const manifestData: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: ["task.md", "inputs/brief.md"],
          optional: ["inputs/extra.md"],
          deep: ["inputs/detailed-specs.md"],
        },
      };

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      const manifestPath = join(inputsDir, "context-manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifestData, null, 2), "utf-8");

      const loaded = await loadManifest(task.frontmatter.id, store);

      expect(loaded).not.toBeNull();
      expect(loaded?.version).toBe("v1");
      expect(loaded?.taskId).toBe(task.frontmatter.id);
      expect(loaded?.layers.seed).toEqual(["task.md", "inputs/brief.md"]);
      expect(loaded?.layers.optional).toEqual(["inputs/extra.md"]);
      expect(loaded?.layers.deep).toEqual(["inputs/detailed-specs.md"]);
    });

    it("handles malformed JSON gracefully", async () => {
      const task = await store.create({
        title: "Task with bad manifest",
        body: "Manifest is malformed",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      const manifestPath = join(inputsDir, "context-manifest.json");
      await writeFile(manifestPath, "{ invalid json }", "utf-8");

      await expect(loadManifest(task.frontmatter.id, store)).rejects.toThrow();
    });

    it("validates manifest structure", async () => {
      const task = await store.create({
        title: "Task with invalid manifest",
        body: "Manifest structure is invalid",
        createdBy: "test",
      });

      const invalidManifest = {
        version: "v1",
        // Missing taskId and layers
      };

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      const manifestPath = join(inputsDir, "context-manifest.json");
      await writeFile(manifestPath, JSON.stringify(invalidManifest), "utf-8");

      await expect(loadManifest(task.frontmatter.id, store)).rejects.toThrow();
    });

    it("handles tasks without inputs directory", async () => {
      const task = await store.create({
        title: "Task with no inputs dir",
        body: "No inputs directory exists",
        createdBy: "test",
      });

      // Delete the inputs directory
      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await rm(inputsDir, { recursive: true, force: true });

      const manifest = await loadManifest(task.frontmatter.id, store);
      expect(manifest).toBeNull();
    });
  });

  describe("saveManifest()", () => {
    it("saves manifest to inputs/context-manifest.json", async () => {
      const task = await store.create({
        title: "Task for save",
        body: "Will save manifest",
        createdBy: "test",
      });

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: ["task.md"],
          optional: ["extra.md"],
          deep: ["deep.md"],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      const manifestPath = join(inputsDir, "context-manifest.json");
      const saved = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(saved);

      expect(parsed.version).toBe("v1");
      expect(parsed.taskId).toBe(task.frontmatter.id);
      expect(parsed.layers.seed).toEqual(["task.md"]);
    });

    it("creates inputs directory if it does not exist", async () => {
      const task = await store.create({
        title: "Task without inputs",
        body: "No inputs dir yet",
        createdBy: "test",
      });

      // Remove inputs directory
      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await rm(inputsDir, { recursive: true, force: true });

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: { seed: [], optional: [], deep: [] },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const manifestPath = join(inputsDir, "context-manifest.json");
      const exists = await readFile(manifestPath, "utf-8").then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it("overwrites existing manifest file", async () => {
      const task = await store.create({
        title: "Task with existing manifest",
        body: "Will overwrite",
        createdBy: "test",
      });

      const oldManifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: { seed: ["old.md"], optional: [], deep: [] },
      };

      await saveManifest(task.frontmatter.id, oldManifest, store);

      const newManifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: { seed: ["new.md"], optional: [], deep: [] },
      };

      await saveManifest(task.frontmatter.id, newManifest, store);

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      const manifestPath = join(inputsDir, "context-manifest.json");
      const saved = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(saved);

      expect(parsed.layers.seed).toEqual(["new.md"]);
    });

    it("formats JSON with proper indentation", async () => {
      const task = await store.create({
        title: "Task for formatted save",
        body: "Check formatting",
        createdBy: "test",
      });

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: { seed: ["file.md"], optional: [], deep: [] },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      const manifestPath = join(inputsDir, "context-manifest.json");
      const saved = await readFile(manifestPath, "utf-8");

      // Check for proper indentation (2 spaces)
      expect(saved).toContain('  "version"');
      expect(saved).toContain('  "taskId"');
    });
  });

  describe("generateDefaultManifest()", () => {
    it("generates manifest with task card in seed layer", () => {
      const taskId = "TASK-2024-01-15-001";
      const manifest = generateDefaultManifest(taskId, []);

      expect(manifest.version).toBe("v1");
      expect(manifest.taskId).toBe(taskId);
      expect(manifest.layers.seed.length).toBeGreaterThan(0);
      expect(manifest.layers.seed[0]).toContain(taskId);
    });

    it("includes input files in seed layer", () => {
      const taskId = "TASK-2024-01-15-002";
      const inputFiles = ["brief.md", "specs.txt", "diagram.png"];
      
      const manifest = generateDefaultManifest(taskId, inputFiles);

      expect(manifest.layers.seed.length).toBeGreaterThan(inputFiles.length);
      expect(manifest.layers.seed).toContain(`${taskId}/inputs/brief.md`);
      expect(manifest.layers.seed).toContain(`${taskId}/inputs/specs.txt`);
      expect(manifest.layers.seed).toContain(`${taskId}/inputs/diagram.png`);
    });

    it("initializes empty optional and deep layers", () => {
      const manifest = generateDefaultManifest("TASK-2024-01-15-003", ["file.md"]);

      expect(manifest.layers.optional).toEqual([]);
      expect(manifest.layers.deep).toEqual([]);
    });

    it("handles empty input files list", () => {
      const manifest = generateDefaultManifest("TASK-2024-01-15-004", []);

      expect(manifest.layers.seed.length).toBe(1); // Just task card
      expect(manifest.layers.optional).toEqual([]);
      expect(manifest.layers.deep).toEqual([]);
    });

    it("generates consistent manifest structure", () => {
      const taskId = "TASK-2024-01-15-005";
      const inputFiles = ["a.md", "b.md"];
      
      const manifest1 = generateDefaultManifest(taskId, inputFiles);
      const manifest2 = generateDefaultManifest(taskId, inputFiles);

      expect(manifest1).toEqual(manifest2);
    });
  });
});
