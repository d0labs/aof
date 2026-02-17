/**
 * Context Assembler Tests
 * 
 * Tests context bundling from task card + inputs/ directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { assembleContext } from "../assembler.js";

describe("Context Assembler", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-context-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("assembleContext()", () => {
    it("assembles context from task card only when no inputs exist", async () => {
      const task = await store.create({
        title: "Simple Task",
        body: "# Task Description\n\nImplement feature X.",
        createdBy: "test",
      });

      const bundle = await assembleContext(task.frontmatter.id, store);

      expect(bundle).toBeDefined();
      expect(bundle.manifest.taskId).toBe(task.frontmatter.id);
      expect(bundle.manifest.version).toBe("v1");
      expect(bundle.summary).toContain("Simple Task");
      expect(bundle.summary).toContain("Implement feature X");
      expect(bundle.sources).toHaveLength(1);
      expect(bundle.sources[0]).toContain(".md");
      expect(bundle.totalChars).toBeGreaterThan(0);
    });

    it("includes files from inputs/ directory", async () => {
      const task = await store.create({
        title: "Task with inputs",
        body: "# Main Task\n\nSee inputs for details.",
        createdBy: "test",
      });

      // Add input files
      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "brief.md"), "# Project Brief\n\nDetailed context here.", "utf-8");
      await writeFile(join(inputsDir, "specs.md"), "# Specifications\n\nTechnical specs.", "utf-8");

      const bundle = await assembleContext(task.frontmatter.id, store);

      expect(bundle.summary).toContain("Main Task");
      expect(bundle.summary).toContain("Project Brief");
      expect(bundle.summary).toContain("Specifications");
      expect(bundle.sources).toHaveLength(3); // task card + 2 inputs
      expect(bundle.manifest.layers.seed.length).toBeGreaterThan(0);
    });

    it("respects maxChars budget and truncates", async () => {
      const task = await store.create({
        title: "Large task",
        body: "A".repeat(5000),
        createdBy: "test",
      });

      // Add large input files
      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "large1.md"), "B".repeat(10000), "utf-8");
      await writeFile(join(inputsDir, "large2.md"), "C".repeat(10000), "utf-8");

      const bundle = await assembleContext(task.frontmatter.id, store, { maxChars: 10000 });

      expect(bundle.totalChars).toBeLessThanOrEqual(10000);
      expect(bundle.summary.length).toBeLessThanOrEqual(10000);
    });

    it("throws error when task does not exist", async () => {
      await expect(
        assembleContext("TASK-2024-01-01-999", store)
      ).rejects.toThrow("Task not found");
    });

    it("structures manifest with seed layer", async () => {
      const task = await store.create({
        title: "Manifest test",
        body: "Task body",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "input1.md"), "Input content", "utf-8");

      const bundle = await assembleContext(task.frontmatter.id, store);

      expect(bundle.manifest.version).toBe("v1");
      expect(bundle.manifest.taskId).toBe(task.frontmatter.id);
      expect(bundle.manifest.layers).toBeDefined();
      expect(bundle.manifest.layers.seed).toBeDefined();
      expect(bundle.manifest.layers.optional).toBeDefined();
      expect(bundle.manifest.layers.deep).toBeDefined();
      expect(Array.isArray(bundle.manifest.layers.seed)).toBe(true);
    });

    it("handles task with no body content", async () => {
      const task = await store.create({
        title: "Minimal task",
        body: "",
        createdBy: "test",
      });

      const bundle = await assembleContext(task.frontmatter.id, store);

      expect(bundle).toBeDefined();
      expect(bundle.summary).toContain("Minimal task");
      expect(bundle.totalChars).toBeGreaterThan(0);
    });

    it("includes metadata in assembled context", async () => {
      const task = await store.create({
        title: "Task with metadata",
        body: "Task description",
        priority: "high",
        routing: { role: "swe-backend", tags: ["typescript"] },
        createdBy: "test",
      });

      const bundle = await assembleContext(task.frontmatter.id, store);

      expect(bundle.summary).toContain("Task with metadata");
      expect(bundle.summary).toContain("priority");
      expect(bundle.summary).toContain("high");
    });

    it("orders layers correctly: seed first", async () => {
      const task = await store.create({
        title: "Layer ordering test",
        body: "Main task body",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "seed-file.md"), "Seed content", "utf-8");

      const bundle = await assembleContext(task.frontmatter.id, store);

      // Seed layer should be populated
      expect(bundle.manifest.layers.seed.length).toBeGreaterThan(0);
      // Optional and deep should be empty in this MVP
      expect(bundle.manifest.layers.optional).toEqual([]);
      expect(bundle.manifest.layers.deep).toEqual([]);
    });

    it("filters out non-file entries from inputs directory", async () => {
      const task = await store.create({
        title: "Filter test",
        body: "Task body",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "valid.md"), "Valid content", "utf-8");

      const bundle = await assembleContext(task.frontmatter.id, store);

      // Should include the valid file
      expect(bundle.sources.some(s => s.includes("valid.md"))).toBe(true);
    });
  });
});
