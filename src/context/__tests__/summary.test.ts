/**
 * Sub-Agent Summary Tests
 * 
 * Tests for generating, writing, and reading sub-agent completion summaries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { generateSummary, writeSummary, readSummary } from "../summary.js";
import type { SubAgentSummary } from "../summary.js";

describe("Sub-Agent Summary", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-summary-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("generateSummary()", () => {
    it("generates minimal summary with required fields", () => {
      const summary = generateSummary({
        taskId: "TASK-2026-02-07-001",
        agentId: "swe-backend",
        result: "success",
        summary: "Completed all requirements successfully.",
        deliverables: ["src/main.ts"],
      });

      expect(summary.taskId).toBe("TASK-2026-02-07-001");
      expect(summary.agentId).toBe("swe-backend");
      expect(summary.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO 8601
      expect(summary.result).toBe("success");
      expect(summary.summary).toBe("Completed all requirements successfully.");
      expect(summary.deliverables).toEqual(["src/main.ts"]);
      expect(summary.testResults).toBeUndefined();
      expect(summary.warnings).toBeUndefined();
    });

    it("generates complete summary with all optional fields", () => {
      const summary = generateSummary({
        taskId: "TASK-2026-02-07-002",
        agentId: "swe-qa",
        result: "partial",
        summary: "Completed core tests but found edge case issues.",
        deliverables: ["tests/unit.test.ts", "tests/integration.test.ts"],
        testResults: {
          total: 50,
          passed: 48,
          failed: 2,
        },
        warnings: [
          "Test coverage at 85%, below 90% target",
          "Two flaky tests identified",
        ],
      });

      expect(summary.taskId).toBe("TASK-2026-02-07-002");
      expect(summary.agentId).toBe("swe-qa");
      expect(summary.result).toBe("partial");
      expect(summary.testResults).toEqual({
        total: 50,
        passed: 48,
        failed: 2,
      });
      expect(summary.warnings).toEqual([
        "Test coverage at 85%, below 90% target",
        "Two flaky tests identified",
      ]);
    });

    it("accepts all valid result types", () => {
      const success = generateSummary({
        taskId: "TASK-001",
        agentId: "agent",
        result: "success",
        summary: "Done",
        deliverables: [],
      });
      expect(success.result).toBe("success");

      const failure = generateSummary({
        taskId: "TASK-002",
        agentId: "agent",
        result: "failure",
        summary: "Failed",
        deliverables: [],
      });
      expect(failure.result).toBe("failure");

      const partial = generateSummary({
        taskId: "TASK-003",
        agentId: "agent",
        result: "partial",
        summary: "Partial",
        deliverables: [],
      });
      expect(partial.result).toBe("partial");
    });

    it("handles empty deliverables array", () => {
      const summary = generateSummary({
        taskId: "TASK-001",
        agentId: "agent",
        result: "failure",
        summary: "Could not complete task due to missing dependencies.",
        deliverables: [],
      });

      expect(summary.deliverables).toEqual([]);
    });
  });

  describe("writeSummary()", () => {
    it("writes summary to task outputs/summary.md", async () => {
      const task = await store.create({
        title: "Test Task",
        body: "Test body",
        createdBy: "test",
      });

      const summary = generateSummary({
        taskId: task.frontmatter.id,
        agentId: "swe-backend",
        result: "success",
        summary: "Implemented feature X with full test coverage.",
        deliverables: ["src/feature-x.ts", "tests/feature-x.test.ts"],
      });

      await writeSummary(task.frontmatter.id, summary, store);

      // Verify file was written
      const outputs = await store.getTaskOutputs(task.frontmatter.id);
      expect(outputs).toContain("summary.md");
    });

    it("formats summary as readable markdown", async () => {
      const task = await store.create({
        title: "Format Test",
        body: "Body",
        createdBy: "test",
      });

      const summary = generateSummary({
        taskId: task.frontmatter.id,
        agentId: "swe-frontend",
        result: "success",
        summary: "Built responsive dashboard component with accessibility features.",
        deliverables: ["src/components/Dashboard.tsx", "src/styles/dashboard.css"],
        testResults: {
          total: 25,
          passed: 25,
          failed: 0,
        },
        warnings: ["Bundle size increased by 15KB"],
      });

      await writeSummary(task.frontmatter.id, summary, store);

      // Read the raw markdown file
      const summaryPath = join(
        store.tasksDir,
        task.frontmatter.status,
        task.frontmatter.id,
        "outputs",
        "summary.md"
      );
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(summaryPath, "utf-8");

      // Check for expected section headers
      expect(content).toContain("# Sub-Agent Summary");
      expect(content).toContain("## Metadata");
      expect(content).toContain("## Result");
      expect(content).toContain("## Summary");
      expect(content).toContain("## Deliverables");
      expect(content).toContain("## Test Results");
      expect(content).toContain("## Warnings");

      // Check content is present
      expect(content).toContain("swe-frontend");
      expect(content).toContain("success");
      expect(content).toContain("Built responsive dashboard");
      expect(content).toContain("src/components/Dashboard.tsx");
      expect(content).toContain("25 tests");
      expect(content).toContain("Bundle size increased");

      // Should NOT be raw JSON
      expect(content).not.toContain('"taskId"');
      expect(content).not.toContain('"agentId"');
    });

    it("omits optional sections when not present", async () => {
      const task = await store.create({
        title: "Minimal Test",
        body: "Body",
        createdBy: "test",
      });

      const summary = generateSummary({
        taskId: task.frontmatter.id,
        agentId: "swe-backend",
        result: "success",
        summary: "Task completed.",
        deliverables: ["output.txt"],
      });

      await writeSummary(task.frontmatter.id, summary, store);

      const summaryPath = join(
        store.tasksDir,
        task.frontmatter.status,
        task.frontmatter.id,
        "outputs",
        "summary.md"
      );
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(summaryPath, "utf-8");

      // Should have required sections
      expect(content).toContain("## Metadata");
      expect(content).toContain("## Result");
      expect(content).toContain("## Summary");
      expect(content).toContain("## Deliverables");

      // Should not have optional sections when data is missing
      expect(content).not.toContain("## Test Results");
      expect(content).not.toContain("## Warnings");
    });

    it("throws error for non-existent task", async () => {
      const summary = generateSummary({
        taskId: "TASK-INVALID",
        agentId: "agent",
        result: "success",
        summary: "Test",
        deliverables: [],
      });

      await expect(writeSummary("TASK-INVALID", summary, store)).rejects.toThrow(
        "Task not found"
      );
    });
  });

  describe("readSummary()", () => {
    it("reads summary from task outputs", async () => {
      const task = await store.create({
        title: "Read Test",
        body: "Body",
        createdBy: "test",
      });

      const original = generateSummary({
        taskId: task.frontmatter.id,
        agentId: "swe-backend",
        result: "success",
        summary: "All features implemented and tested.",
        deliverables: ["src/app.ts"],
      });

      await writeSummary(task.frontmatter.id, original, store);
      const read = await readSummary(task.frontmatter.id, store);

      expect(read).toBeDefined();
      expect(read!.taskId).toBe(original.taskId);
      expect(read!.agentId).toBe(original.agentId);
      expect(read!.result).toBe(original.result);
      expect(read!.summary).toBe(original.summary);
      expect(read!.deliverables).toEqual(original.deliverables);
    });

    it("returns null when summary.md does not exist", async () => {
      const task = await store.create({
        title: "No Summary",
        body: "Body",
        createdBy: "test",
      });

      const result = await readSummary(task.frontmatter.id, store);
      expect(result).toBeNull();
    });

    it("throws error for non-existent task", async () => {
      await expect(readSummary("TASK-INVALID", store)).rejects.toThrow(
        "Task not found"
      );
    });

    it("preserves all fields through write-read round trip", async () => {
      const task = await store.create({
        title: "Round Trip Test",
        body: "Body",
        createdBy: "test",
      });

      const original: SubAgentSummary = {
        taskId: task.frontmatter.id,
        agentId: "swe-qa",
        completedAt: "2026-02-07T19:30:00.000Z",
        result: "partial",
        summary: "Completed most tests but infrastructure issues prevented full run.",
        deliverables: ["tests/unit.test.ts", "tests/e2e.test.ts"],
        testResults: {
          total: 100,
          passed: 95,
          failed: 5,
        },
        warnings: ["CI pipeline timeout", "Flaky network tests"],
      };

      await writeSummary(task.frontmatter.id, original, store);
      const read = await readSummary(task.frontmatter.id, store);

      expect(read).toEqual(original);
    });
  });
});
