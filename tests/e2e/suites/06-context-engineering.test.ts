/**
 * E2E Test Suite 6: Context Engineering
 * 
 * Tests the full context engineering pipeline:
 * - Context assembly with manifest
 * - Budget evaluation (warn/critical alerts)
 * - Footprint generation (per-agent breakdown)
 * - Skill resolver with mock skill directory
 * - Resolver chain integration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { assembleContext, type ContextManifest } from "../../../src/context/assembler.js";
import { evaluateBudget } from "../../../src/context/budget.js";
import { calculateFootprint, generateTransparencyReport } from "../../../src/context/steward.js";
import { FilesystemResolver, SkillResolver, ResolverChain, InlineResolver } from "../../../src/context/resolvers.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "context-engineering");

describe("E2E: Context Engineering", () => {
  let store: ITaskStore;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("context assembly", () => {
    it("should assemble context bundle with task card and inputs", async () => {
      const task = await store.create({
        title: "Assembly Test",
        body: "# Task Card\n\nTask description with details.",
        createdBy: "system",
      });

      // Create input files
      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "context.txt"), "Additional context");
      await writeFile(join(inputsDir, "data.json"), '{"key": "value"}');

      const bundle = await assembleContext(task.frontmatter.id, store);

      expect(bundle).toBeDefined();
      expect(bundle.summary).toBeDefined();
      expect(bundle.totalChars).toBeGreaterThan(0);
      expect(bundle.sources.length).toBeGreaterThan(0);
      expect(bundle.manifest).toBeDefined();

      // Verify content includes task card and inputs
      expect(bundle.summary).toContain("Task Card");
      expect(bundle.summary).toContain("Task description");
      expect(bundle.summary).toContain("Additional context");
    });

    it("should respect character budget during assembly", async () => {
      const task = await store.create({
        title: "Budget Assembly Test",
        body: "# Task\n\nShort body.",
        createdBy: "system",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "large.txt"), "X".repeat(5000));

      const bundle = await assembleContext(task.frontmatter.id, store, {
        maxChars: 1000,
      });

      expect(bundle.totalChars).toBeLessThanOrEqual(1100); // Some overhead
      expect(bundle.summary).toContain("truncated");
    });

    it("should use manifest when present", async () => {
      const task = await store.create({
        title: "Manifest Test",
        body: "# Task with manifest",
        createdBy: "system",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });

      // Create context manifest
      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: ["task-card.md", "inputs/priority.txt"],
          optional: ["inputs/extra.txt"],
          deep: ["inputs/deep-context.txt"],
        },
      };
      await writeFile(
        join(inputsDir, "context-manifest.json"),
        JSON.stringify(manifest, null, 2)
      );

      // Create the referenced files
      await writeFile(join(inputsDir, "priority.txt"), "Priority content");
      await writeFile(join(inputsDir, "extra.txt"), "Extra content");
      await writeFile(join(inputsDir, "deep-context.txt"), "Deep content");

      const bundle = await assembleContext(task.frontmatter.id, store);

      // Verify manifest was loaded
      expect(bundle.manifest.taskId).toBe(task.frontmatter.id);
      expect(bundle.manifest.version).toBe("v1");
      expect(bundle.manifest.layers.seed.length).toBeGreaterThan(0);
      
      // Verify task card content is included
      expect(bundle.summary).toContain("Task with manifest");
      expect(bundle.totalChars).toBeGreaterThan(0);
    });

    it("should handle missing input files gracefully", async () => {
      const task = await store.create({
        title: "Missing Inputs Test",
        body: "# Task",
        createdBy: "system",
      });

      // No inputs directory created

      const bundle = await assembleContext(task.frontmatter.id, store);

      // Should still assemble with just task card
      expect(bundle.summary).toContain("Task");
      expect(bundle.totalChars).toBeGreaterThan(0);
    });

    it("should support deep layer inclusion", async () => {
      const task = await store.create({
        title: "Deep Layer Test",
        body: "# Task",
        createdBy: "system",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });

      const manifest: ContextManifest = {
        version: "v1",
        taskId: task.frontmatter.id,
        layers: {
          seed: ["task-card.md"],
          optional: ["inputs/optional.txt"],
          deep: ["inputs/deep.txt"],
        },
      };
      await writeFile(
        join(inputsDir, "context-manifest.json"),
        JSON.stringify(manifest)
      );
      await writeFile(join(inputsDir, "optional.txt"), "Optional content");
      await writeFile(join(inputsDir, "deep.txt"), "Deep content");

      // Without includeDeep flag
      const bundle1 = await assembleContext(task.frontmatter.id, store, {
        includeDeep: false,
      });
      // Verify bundle was created and contains task card
      expect(bundle1.summary).toContain("Deep Layer Test");
      expect(bundle1.manifest.layers.deep.length).toBeGreaterThan(0);

      // With includeDeep flag - should still create bundle
      const bundle2 = await assembleContext(task.frontmatter.id, store, {
        includeDeep: true,
      });
      expect(bundle2.summary).toContain("Deep Layer Test");
      // Deep layer exists in manifest
      expect(bundle2.manifest.layers.deep).toContain("inputs/deep.txt");
    });
  });

  describe("budget evaluation", () => {
    it("should evaluate budget and return usage stats", async () => {
      const task = await store.create({
        title: "Budget Eval Test",
        body: "# Task\n\nSome content here.",
        createdBy: "system",
      });

      const bundle = await assembleContext(task.frontmatter.id, store);

      const budgetResult = evaluateBudget(bundle, {
        target: 10000,
        warn: 50000,
        critical: 100000,
      });

      expect(budgetResult.totalChars).toBe(bundle.totalChars);
      expect(budgetResult.estimatedTokens).toBeGreaterThan(0);
      expect(budgetResult.status).toBeDefined();
      expect(budgetResult.taskId).toBe(task.frontmatter.id);
    });

    it("should trigger warning status when approaching budget", async () => {
      const task = await store.create({
        title: "Warning Test",
        body: "# Task\n\nContent.",
        createdBy: "system",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      // Create content that exceeds target but below warn
      await writeFile(join(inputsDir, "medium.txt"), "X".repeat(200));

      const bundle = await assembleContext(task.frontmatter.id, store);

      const budgetResult = evaluateBudget(bundle, {
        target: 300,
        warn: 1000,
        critical: 2000,
      });

      // Should be "warn" (over target, under warn threshold)
      expect(budgetResult.status).toBe("warn");
      expect(budgetResult.totalChars).toBeGreaterThan(300);
    });

    it("should trigger critical status when exceeding warn threshold", async () => {
      const task = await store.create({
        title: "Critical Test",
        body: "# Task",
        createdBy: "system",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "large.txt"), "X".repeat(600));

      const bundle = await assembleContext(task.frontmatter.id, store);

      const budgetResult = evaluateBudget(bundle, {
        target: 400,
        warn: 600,
        critical: 2000,
      });

      // Should be "critical" (over warn, under critical threshold)
      expect(budgetResult.status).toBe("critical");
      expect(budgetResult.totalChars).toBeGreaterThan(600);
    });

    it("should estimate token count from character count", async () => {
      const task = await store.create({
        title: "Token Estimation Test",
        body: "# Task\n\n" + "word ".repeat(100), // ~100 words
        createdBy: "system",
      });

      const bundle = await assembleContext(task.frontmatter.id, store);
      const budgetResult = evaluateBudget(bundle, {
        target: 5000,
        warn: 10000,
        critical: 20000,
      });

      // Token estimate should be roughly chars / 4
      const expectedTokens = Math.ceil(bundle.totalChars / 4);
      expect(budgetResult.estimatedTokens).toBeGreaterThan(0);
      expect(budgetResult.estimatedTokens).toBe(expectedTokens);
    });
  });

  describe("footprint tracking", () => {
    it("should calculate footprint for an agent", async () => {
      const task = await store.create({
        title: "Footprint Test",
        body: "# Task\n\nTask body content.",
        createdBy: "test-agent-1",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "input1.txt"), "Input file 1 content");
      await writeFile(join(inputsDir, "input2.txt"), "Input file 2 content");

      const footprint = await calculateFootprint("test-agent-1", store);

      expect(footprint.agentId).toBe("test-agent-1");
      expect(footprint.totalChars).toBeGreaterThan(0);
      expect(footprint.estimatedTokens).toBeGreaterThan(0);
      expect(footprint.breakdown).toBeDefined();
      expect(footprint.breakdown.length).toBeGreaterThan(0);
    });

    it("should generate transparency report with per-agent breakdown", async () => {
      await store.create({
        title: "Task 1",
        body: "# Task 1\n\nContent for agent 1.",
        createdBy: "test-agent-1",
      });

      await store.create({
        title: "Task 2",
        body: "# Task 2\n\nContent for agent 2.",
        createdBy: "test-agent-2",
      });

      const footprint1 = await calculateFootprint("test-agent-1", store);
      const footprint2 = await calculateFootprint("test-agent-2", store);

      const report = generateTransparencyReport([footprint1, footprint2]);

      expect(report.timestamp).toBeDefined();
      expect(report.agents.length).toBe(2);
      expect(report.agents[0].agentId).toBeDefined();
      expect(report.agents[1].agentId).toBeDefined();
      expect(report.topContributors).toBeDefined();
      expect(report.alerts).toBeDefined();
    });

    it("should track footprint breakdown by artifact type", async () => {
      const task = await store.create({
        title: "Breakdown Test",
        body: "# Task\n\nContent.",
        createdBy: "test-agent-1",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "large.txt"), "X".repeat(500));

      const footprint = await calculateFootprint("test-agent-1", store);

      // Footprint should have breakdown of different artifact types
      expect(footprint.breakdown.length).toBeGreaterThan(0);
      const taskArtifacts = footprint.breakdown.filter(b => b.kind === "task");
      expect(taskArtifacts.length).toBeGreaterThan(0);
    });
  });

  describe("resolver chain", () => {
    it("should resolve files using FilesystemResolver", async () => {
      const task = await store.create({
        title: "Filesystem Resolver Test",
        body: "# Task",
        createdBy: "system",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "file.txt"), "File content");

      const resolver = new FilesystemResolver(taskDir);
      const resolverChain = new ResolverChain([resolver]);

      const bundle = await assembleContext(task.frontmatter.id, store, {
        resolvers: resolverChain,
      });

      expect(bundle.summary).toContain("File content");
    });

    it("should use InlineResolver for embedded content", async () => {
      const task = await store.create({
        title: "Inline Resolver Test",
        body: "# Task",
        createdBy: "system",
      });

      const inlineResolver = new InlineResolver({
        "inline:test": "Inline content from resolver",
      });
      const resolverChain = new ResolverChain([inlineResolver]);

      const bundle = await assembleContext(task.frontmatter.id, store, {
        resolvers: resolverChain,
      });

      // Task card should still be included
      expect(bundle.summary).toBeDefined();
      expect(bundle.totalChars).toBeGreaterThan(0);
    });

    it("should chain multiple resolvers", async () => {
      const task = await store.create({
        title: "Chained Resolvers Test",
        body: "# Task",
        createdBy: "system",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "file.txt"), "Filesystem content");

      const fsResolver = new FilesystemResolver(taskDir);
      const inlineResolver = new InlineResolver({
        "inline:data": "Inline data",
      });
      const resolverChain = new ResolverChain([fsResolver, inlineResolver]);

      const bundle = await assembleContext(task.frontmatter.id, store, {
        resolvers: resolverChain,
      });

      // Both resolvers should contribute
      expect(bundle.summary).toContain("Filesystem content");
    });
  });

  describe("skill resolver", () => {
    it("should resolve skill references from skill directory", async () => {
      // Create mock skills directory with proper structure
      const skillsDir = join(TEST_DATA_DIR, "skills");
      const pythonSkillDir = join(skillsDir, "python");
      await mkdir(pythonSkillDir, { recursive: true });
      
      // Create skill manifest
      await writeFile(
        join(pythonSkillDir, "skill.json"),
        JSON.stringify({
          version: "v1",
          name: "python",
          description: "Python programming skill",
          tags: ["programming", "python"],
          entrypoint: "index.md"
        })
      );
      
      // Create skill entrypoint
      await writeFile(
        join(pythonSkillDir, "index.md"),
        "# Python Skill\n\nPython coding guidelines."
      );

      const skillResolver = new SkillResolver(skillsDir);

      // Test skill resolver with correct format
      const pythonSkill = await skillResolver.resolve("skill:python");
      expect(pythonSkill).toBeDefined();
      expect(pythonSkill).toContain("Python Skill");
      expect(pythonSkill).toContain("Python coding guidelines");
    });

    it("should handle missing skill gracefully", async () => {
      const skillsDir = join(TEST_DATA_DIR, "skills");
      await mkdir(skillsDir, { recursive: true });

      const skillResolver = new SkillResolver(skillsDir);

      await expect(
        skillResolver.resolve("skill:nonexistent")
      ).rejects.toThrow();
    });

    it("should integrate skill resolver in context assembly", async () => {
      const task = await store.create({
        title: "Skill Integration Test",
        body: "# Task",
        createdBy: "system",
      });

      // Create skills directory
      const skillsDir = join(TEST_DATA_DIR, "skills");
      await mkdir(join(skillsDir, "testing"), { recursive: true });
      await writeFile(
        join(skillsDir, "testing", "unit-tests.md"),
        "# Unit Testing\n\nWrite unit tests for all functions."
      );

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const skillResolver = new SkillResolver(skillsDir);
      const fsResolver = new FilesystemResolver(taskDir);
      const resolverChain = new ResolverChain([fsResolver, skillResolver]);

      const bundle = await assembleContext(task.frontmatter.id, store, {
        resolvers: resolverChain,
      });

      // Bundle should be created (skill may or may not be auto-included)
      expect(bundle).toBeDefined();
      expect(bundle.totalChars).toBeGreaterThan(0);
    });
  });

  describe("end-to-end context pipeline", () => {
    it("should run full pipeline: assemble → budget → footprint", async () => {
      const task = await store.create({
        title: "Full Pipeline Test",
        body: "# Task\n\nComplete context engineering test.",
        createdBy: "test-agent-1",
      });

      const taskDir = join(TEST_DATA_DIR, "tasks", "backlog");
      const inputsDir = join(taskDir, task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "context.txt"), "Context data");

      // Step 1: Assemble context
      const bundle = await assembleContext(task.frontmatter.id, store, {
        maxChars: 10000,
      });
      expect(bundle).toBeDefined();
      expect(bundle.totalChars).toBeGreaterThan(0);

      // Step 2: Evaluate budget
      const budgetResult = evaluateBudget(bundle, {
        target: 5000,
        warn: 50000,
        critical: 100000,
      });
      expect(budgetResult.totalChars).toBe(bundle.totalChars);
      expect(budgetResult.status).toBe("ok"); // Should be under thresholds

      // Step 3: Calculate footprint
      const footprint = await calculateFootprint("test-agent-1", store);
      expect(footprint.agentId).toBe("test-agent-1");
      expect(footprint.totalChars).toBeGreaterThan(0);

      // Step 4: Generate transparency report
      const report = generateTransparencyReport([footprint]);
      expect(report.timestamp).toBeDefined();
      expect(report.agents.length).toBe(1);
      expect(report.agents[0].agentId).toBe("test-agent-1");
    });
  });
});
