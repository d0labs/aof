/**
 * Enhanced Context Assembler Tests
 * 
 * Tests manifest-driven resolution, optional/deep layers, and custom resolvers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { assembleContext } from "../assembler.js";
import { FilesystemResolver, InlineResolver, ResolverChain } from "../resolvers.js";
import { saveManifest } from "../manifest.js";
import type { ContextManifest } from "../assembler.js";

describe("Enhanced Context Assembler", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-assembler-enhanced-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("Custom Resolvers", () => {
    it("uses custom resolver chain when provided", async () => {
      const task = await store.create({
        title: "Task with custom resolver",
        body: "Uses inline content",
        createdBy: "test",
      });

      const inlineContent = {
        "custom-doc": "# Custom Document\n\nInline content from resolver.",
      };

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [`tasks/backlog/${task.frontmatter.id}.md`, "custom-doc"],
          optional: [],
          deep: [],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const inline = new InlineResolver(inlineContent);
      const fs = new FilesystemResolver(tmpDir);
      const resolvers = new ResolverChain([inline, fs]);

      const bundle = await assembleContext(task.frontmatter.id, store, { resolvers });

      expect(bundle.summary).toContain("Custom Document");
      expect(bundle.summary).toContain("Inline content from resolver");
    });

    it("falls back to filesystem when inline resolver cannot resolve", async () => {
      const task = await store.create({
        title: "Mixed resolution",
        body: "Uses both resolvers",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "file.md"), "# Filesystem File\n\nFrom disk.", "utf-8");

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [`tasks/backlog/${task.frontmatter.id}.md`, `tasks/backlog/${task.frontmatter.id}/inputs/file.md`],
          optional: [],
          deep: [],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const inline = new InlineResolver({ "other": "Other content" });
      const fs = new FilesystemResolver(tmpDir);
      const resolvers = new ResolverChain([inline, fs]);

      const bundle = await assembleContext(task.frontmatter.id, store, { resolvers });

      expect(bundle.summary).toContain("Filesystem File");
      expect(bundle.summary).toContain("From disk");
    });

    it("maintains backward compatibility without custom resolvers", async () => {
      const task = await store.create({
        title: "Backward compatible task",
        body: "No custom resolvers",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "input.md"), "Standard input content", "utf-8");

      const bundle = await assembleContext(task.frontmatter.id, store);

      expect(bundle.summary).toContain("Backward compatible task");
      expect(bundle.summary).toContain("Standard input content");
    });
  });

  describe("Manifest-Driven Resolution", () => {
    it("uses manifest from inputs/context-manifest.json when present", async () => {
      const task = await store.create({
        title: "Task with manifest",
        body: "Driven by manifest",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "seed-file.md"), "Seed layer content", "utf-8");
      await writeFile(join(inputsDir, "optional-file.md"), "Optional layer content", "utf-8");

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [
            `tasks/backlog/${task.frontmatter.id}.md`,
            `${task.frontmatter.id}/inputs/seed-file.md`,
          ],
          optional: [`${task.frontmatter.id}/inputs/optional-file.md`],
          deep: [],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const bundle = await assembleContext(task.frontmatter.id, store);

      expect(bundle.summary).toContain("Seed layer content");
      // Optional should be included by default (if budget allows)
      expect(bundle.summary).toContain("Optional layer content");
    });

    it("skips optional layer when it would exceed budget", async () => {
      const task = await store.create({
        title: "Budget test",
        body: "A".repeat(500),
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "optional.md"), "B".repeat(5000), "utf-8");

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [`tasks/backlog/${task.frontmatter.id}.md`],
          optional: [`${task.frontmatter.id}/inputs/optional.md`],
          deep: [],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const bundle = await assembleContext(task.frontmatter.id, store, { maxChars: 2000 });

      expect(bundle.totalChars).toBeLessThanOrEqual(2000);
      // Optional should be excluded due to budget
      expect(bundle.summary).toContain("Budget test");
    });

    it("falls back to legacy behavior when no manifest exists", async () => {
      const task = await store.create({
        title: "No manifest task",
        body: "Uses legacy behavior",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "input1.md"), "Input 1", "utf-8");
      await writeFile(join(inputsDir, "input2.md"), "Input 2", "utf-8");

      const bundle = await assembleContext(task.frontmatter.id, store);

      // Should include all inputs (legacy behavior)
      expect(bundle.summary).toContain("Input 1");
      expect(bundle.summary).toContain("Input 2");
      expect(bundle.manifest.layers.seed.length).toBeGreaterThan(0);
    });
  });

  describe("Optional Layer Resolution", () => {
    it("includes optional layer entries when budget allows", async () => {
      const task = await store.create({
        title: "Optional inclusion test",
        body: "Short task body",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "extra.md"), "Extra optional content", "utf-8");

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [`tasks/backlog/${task.frontmatter.id}.md`],
          optional: [`${task.frontmatter.id}/inputs/extra.md`],
          deep: [],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const bundle = await assembleContext(task.frontmatter.id, store);

      expect(bundle.summary).toContain("Extra optional content");
      expect(bundle.sources).toContain(`${task.frontmatter.id}/inputs/extra.md`);
    });

    it("processes optional entries in order until budget exhausted", async () => {
      const task = await store.create({
        title: "Optional ordering test",
        body: "Test",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "opt1.md"), "Optional 1 " + "x".repeat(500), "utf-8");
      await writeFile(join(inputsDir, "opt2.md"), "Optional 2 " + "y".repeat(500), "utf-8");
      await writeFile(join(inputsDir, "opt3.md"), "Optional 3 " + "z".repeat(5000), "utf-8");

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [`tasks/backlog/${task.frontmatter.id}.md`],
          optional: [
            `${task.frontmatter.id}/inputs/opt1.md`,
            `${task.frontmatter.id}/inputs/opt2.md`,
            `${task.frontmatter.id}/inputs/opt3.md`,
          ],
          deep: [],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const bundle = await assembleContext(task.frontmatter.id, store, { maxChars: 2000 });

      expect(bundle.totalChars).toBeLessThanOrEqual(2000);
      expect(bundle.summary).toContain("Optional 1");
      expect(bundle.summary).toContain("Optional 2");
      // opt3 should be excluded (too large)
    });
  });

  describe("Deep Layer Resolution", () => {
    it("excludes deep layer by default", async () => {
      const task = await store.create({
        title: "Deep layer default test",
        body: "Task body",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "deep-doc.md"), "Deep detailed content", "utf-8");

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [`tasks/backlog/${task.frontmatter.id}.md`],
          optional: [],
          deep: [`${task.frontmatter.id}/inputs/deep-doc.md`],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const bundle = await assembleContext(task.frontmatter.id, store);

      // Deep layer should NOT be included by default
      expect(bundle.summary).not.toContain("Deep detailed content");
    });

    it("includes deep layer when includeDeep is true", async () => {
      const task = await store.create({
        title: "Deep layer explicit test",
        body: "Task body",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "deep-doc.md"), "Deep detailed content", "utf-8");

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [`tasks/backlog/${task.frontmatter.id}.md`],
          optional: [],
          deep: [`${task.frontmatter.id}/inputs/deep-doc.md`],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const bundle = await assembleContext(task.frontmatter.id, store, { includeDeep: true });

      expect(bundle.summary).toContain("Deep detailed content");
      expect(bundle.sources).toContain(`${task.frontmatter.id}/inputs/deep-doc.md`);
    });

    it("respects budget even with includeDeep=true", async () => {
      const task = await store.create({
        title: "Deep budget test",
        body: "A".repeat(1000),
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "deep.md"), "B".repeat(10000), "utf-8");

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [`tasks/backlog/${task.frontmatter.id}.md`],
          optional: [],
          deep: [`${task.frontmatter.id}/inputs/deep.md`],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const bundle = await assembleContext(task.frontmatter.id, store, {
        includeDeep: true,
        maxChars: 3000,
      });

      expect(bundle.totalChars).toBeLessThanOrEqual(3000);
    });
  });

  describe("Layer Processing Order", () => {
    it("processes layers in correct order: seed → optional → deep", async () => {
      const task = await store.create({
        title: "Layer order test",
        body: "Task",
        createdBy: "test",
      });

      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await writeFile(join(inputsDir, "seed.md"), "SEED", "utf-8");
      await writeFile(join(inputsDir, "optional.md"), "OPTIONAL", "utf-8");
      await writeFile(join(inputsDir, "deep.md"), "DEEP", "utf-8");

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: [`tasks/backlog/${task.frontmatter.id}.md`, `${task.frontmatter.id}/inputs/seed.md`],
          optional: [`${task.frontmatter.id}/inputs/optional.md`],
          deep: [`${task.frontmatter.id}/inputs/deep.md`],
        },
      };

      await saveManifest(task.frontmatter.id, manifest, store);

      const bundle = await assembleContext(task.frontmatter.id, store, { includeDeep: true });

      const seedIndex = bundle.summary.indexOf("SEED");
      const optIndex = bundle.summary.indexOf("OPTIONAL");
      const deepIndex = bundle.summary.indexOf("DEEP");

      expect(seedIndex).toBeGreaterThan(0);
      expect(optIndex).toBeGreaterThan(seedIndex);
      expect(deepIndex).toBeGreaterThan(optIndex);
    });
  });
});
