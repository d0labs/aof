/**
 * E2E Test Suite 11: Workflow Gates - Tool Completion with Outcomes
 * 
 * Tests the extended aof_task_complete tool with gate workflow outcomes:
 * - outcome parameter (complete | needs_review | blocked)
 * - blockers array for needs_review/blocked outcomes
 * - rejectionNotes for needs_review outcome
 * - Backward compatibility (omitting outcome defaults to "complete")
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskStore } from "../../../src/store/task-store.js";
import { EventLogger } from "../../../src/events/logger.js";
import { aofTaskComplete, type ToolContext } from "../../../src/tools/aof-tools.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "workflow-gates-completion");

describe("E2E: Workflow Gates - Tool Completion with Outcomes", () => {
  let store: TaskStore;
  let logger: EventLogger;
  let ctx: ToolContext;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new TaskStore(TEST_DATA_DIR);
    logger = new EventLogger(join(TEST_DATA_DIR, "events"));
    ctx = { store, logger };
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("backward compatibility", () => {
    it("should complete task when outcome is omitted (default to 'complete')", async () => {
      // Create task and move to review
      const task = await store.create({
        title: "Legacy completion test",
        body: "# Work to be done",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // Complete without outcome parameter (legacy behavior)
      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
        summary: "Task completed successfully.",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("done");
    });

    it("should complete task with explicit outcome='complete'", async () => {
      const task = await store.create({
        title: "Explicit complete outcome",
        body: "# Work to be done",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // Complete with explicit outcome
      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
        summary: "Implemented JWT middleware with tests, 85% coverage",
        outcome: "complete",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("done");
    });
  });

  describe("outcome='needs_review' (rejection)", () => {
    it("should accept needs_review outcome with blockers", async () => {
      const task = await store.create({
        title: "Task needing review",
        body: "# Implementation",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      // Complete with needs_review outcome
      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "reviewer-agent",
        summary: "Implementation needs revision before advancing",
        outcome: "needs_review",
        blockers: [
          "Missing error handling for expired tokens",
          "Test coverage at 65%, target is 80%",
        ],
        rejectionNotes: "Please address these issues and resubmit",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      // Note: actual gate transition logic is tested in gate-transition-handler tests
      // This test verifies the tool accepts the parameters
    });

    it("should accept needs_review with blockers array", async () => {
      const task = await store.create({
        title: "Rejection test",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "reviewer",
        summary: "Code review found issues",
        outcome: "needs_review",
        blockers: ["Missing validation logic", "Incomplete test suite"],
        rejectionNotes: "Address blockers and resubmit for review",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
    });
  });

  describe("outcome='blocked' (external blocker)", () => {
    it("should accept blocked outcome with blockers", async () => {
      const task = await store.create({
        title: "Blocked task",
        body: "# Waiting for dependency",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "implementer",
        summary: "Waiting for API spec from external team",
        outcome: "blocked",
        blockers: ["Need finalized API spec from platform team"],
      });

      expect(result.taskId).toBe(task.frontmatter.id);
    });

    it("should accept blocked outcome with multiple blockers", async () => {
      const task = await store.create({
        title: "Multiple blockers test",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "agent",
        summary: "Blocked on multiple external dependencies",
        outcome: "blocked",
        blockers: [
          "Waiting for database migration approval",
          "Need access to production environment",
          "Blocked on security audit completion",
        ],
      });

      expect(result.taskId).toBe(task.frontmatter.id);
    });
  });

  describe("parameter validation", () => {
    it("should handle summary parameter", async () => {
      const task = await store.create({
        title: "Summary test",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "agent",
        summary: "Implemented authentication with JWT, added tests for token validation and expiry",
        outcome: "complete",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      
      // Verify summary was written to task body
      const completed = await store.get(task.frontmatter.id);
      expect(completed?.body).toContain("Implemented authentication with JWT");
    });

    it("should handle rejectionNotes parameter", async () => {
      const task = await store.create({
        title: "Rejection notes test",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "reviewer",
        summary: "Code review completed",
        outcome: "needs_review",
        blockers: ["Missing edge case handling"],
        rejectionNotes: "Please add tests for edge cases: empty input, null values, and boundary conditions",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
    });

    it("should handle empty blockers array gracefully", async () => {
      const task = await store.create({
        title: "Empty blockers test",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "agent",
        summary: "Work completed",
        outcome: "complete",
        blockers: [], // Empty array should be accepted
      });

      expect(result.taskId).toBe(task.frontmatter.id);
    });

    it("should handle omitted optional parameters", async () => {
      const task = await store.create({
        title: "Minimal params test",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // Minimal call with just taskId and summary
      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        summary: "Done",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("done");
    });
  });

  describe("tool response format", () => {
    it("should return consistent envelope format with outcome parameters", async () => {
      const task = await store.create({
        title: "Envelope format test",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "agent",
        summary: "Completed with outcome",
        outcome: "complete",
      });

      // Verify envelope structure
      expect(result).toHaveProperty("summary");
      expect(result).toHaveProperty("taskId");
      expect(result).toHaveProperty("status");
      expect(typeof result.summary).toBe("string");
      expect(typeof result.taskId).toBe("string");
      expect(typeof result.status).toBe("string");
    });

    it("should return envelope with needs_review outcome", async () => {
      const task = await store.create({
        title: "Needs review envelope",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "reviewer",
        summary: "Review feedback",
        outcome: "needs_review",
        blockers: ["Issue found"],
      });

      expect(result).toHaveProperty("summary");
      expect(result).toHaveProperty("taskId");
      expect(result).toHaveProperty("status");
    });
  });
});
