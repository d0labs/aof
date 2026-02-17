/**
 * E2E Test Suite 12: Gate Validation Errors with Teaching Messages
 * 
 * Tests that invalid gate interactions return actionable, teaching error messages.
 * This is Progressive Disclosure Level 3 — when agents make mistakes, the error
 * teaches them the correct approach.
 * 
 * Error scenarios tested:
 * 1. Invalid outcome value
 * 2. Rejection at non-rejectable gate
 * 3. needs_review without rejectionNotes
 * 4. blocked without blockers
 * 5. Graceful fallback for non-workflow tasks
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { EventLogger } from "../../../src/events/logger.js";
import { aofTaskComplete, type ToolContext } from "../../../src/tools/aof-tools.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFile, mkdir } from "node:fs/promises";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "gate-validation-errors");

describe("E2E: Gate Validation Errors with Teaching Messages", () => {
  let store: ITaskStore;
  let logger: EventLogger;
  let ctx: ToolContext;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
    logger = new EventLogger(join(TEST_DATA_DIR, "events"));
    ctx = { store, logger };
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("Scenario 1: Invalid outcome value", () => {
    it("should provide teaching error for invalid outcome", async () => {
      const task = await store.create({
        title: "Test task",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      // Create a simple workflow
      const projectYaml = `
id: test
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: test-agent
workflow:
  name: simple-workflow
  gates:
    - id: dev
      role: swe-backend
      canReject: false
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      // Add gate to task
      task.frontmatter.gate = { current: "dev", entered: new Date().toISOString() };
      task.frontmatter.routing = { role: "swe-backend", workflow: "simple-workflow" };
      const { serializeTask } = await import("../../../src/store/task-store.js");
      const writeFileAtomic = (await import("write-file-atomic")).default;
      const taskPath = join(TEST_DATA_DIR, "tasks", task.frontmatter.status, `${task.frontmatter.id}.md`);
      await writeFileAtomic(taskPath, serializeTask(task));

      // Try to complete with invalid outcome
      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Done",
          outcome: "done" as any, // Invalid outcome
        })
      ).rejects.toThrow(/Expected one of: complete, needs_review, blocked/);

      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Done",
          outcome: "done" as any,
        })
      ).rejects.toThrow(/You sent 'done'/);

      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Done",
          outcome: "done" as any,
        })
      ).rejects.toThrow(/Use 'complete' to advance/);
    });
  });

  describe("Scenario 2: Rejection at non-rejectable gate", () => {
    it("should provide teaching error when trying to reject at canReject=false gate", async () => {
      const task = await store.create({
        title: "Test task",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      // Create workflow with non-rejectable gate
      const projectYaml = `
id: test
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: test-agent
workflow:
  name: simple-workflow
  gates:
    - id: ready-check
      role: swe-backend
      canReject: false
    - id: qa
      role: swe-qa
      canReject: true
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      // Add gate to task
      task.frontmatter.gate = { current: "ready-check", entered: new Date().toISOString() };
      task.frontmatter.routing = { role: "swe-backend", workflow: "simple-workflow" };
      const { serializeTask } = await import("../../../src/store/task-store.js");
      const writeFileAtomic = (await import("write-file-atomic")).default;
      const taskPath = join(TEST_DATA_DIR, "tasks", task.frontmatter.status, `${task.frontmatter.id}.md`);
      await writeFileAtomic(taskPath, serializeTask(task));

      // Try to reject at non-rejectable gate
      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Rejecting",
          outcome: "needs_review",
          blockers: ["Issue found"],
          rejectionNotes: "Please fix",
        })
      ).rejects.toThrow(/This gate \(ready-check\) does not allow rejection/);

      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Rejecting",
          outcome: "needs_review",
          blockers: ["Issue found"],
          rejectionNotes: "Please fix",
        })
      ).rejects.toThrow(/Use 'complete' to advance to the next gate/);
    });
  });

  describe("Scenario 3: needs_review without rejectionNotes", () => {
    it("should provide teaching error when rejectionNotes is missing", async () => {
      const task = await store.create({
        title: "Test task",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      // Create workflow with rejectable gate
      const projectYaml = `
id: test
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: test-agent
workflow:
  name: simple-workflow
  gates:
    - id: dev
      role: swe-backend
      canReject: false
    - id: qa
      role: swe-qa
      canReject: true
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      // Add gate to task
      task.frontmatter.gate = { current: "qa", entered: new Date().toISOString() };
      task.frontmatter.routing = { role: "swe-qa", workflow: "simple-workflow" };
      const { serializeTask } = await import("../../../src/store/task-store.js");
      const writeFileAtomic = (await import("write-file-atomic")).default;
      const taskPath = join(TEST_DATA_DIR, "tasks", task.frontmatter.status, `${task.frontmatter.id}.md`);
      await writeFileAtomic(taskPath, serializeTask(task));

      // Try needs_review without rejectionNotes
      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Found issues",
          outcome: "needs_review",
          blockers: ["Missing tests"],
          // rejectionNotes missing
        })
      ).rejects.toThrow(/When rejecting work \(needs_review\), you must provide rejectionNotes/);

      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Found issues",
          outcome: "needs_review",
          blockers: ["Missing tests"],
        })
      ).rejects.toThrow(/explaining what needs to change/);
    });

    it("should provide teaching error when rejectionNotes is empty string", async () => {
      const task = await store.create({
        title: "Test task",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const projectYaml = `
id: test
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: test-agent
workflow:
  name: simple-workflow
  gates:
    - id: qa
      role: swe-qa
      canReject: true
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      task.frontmatter.gate = { current: "qa", entered: new Date().toISOString() };
      task.frontmatter.routing = { role: "swe-qa", workflow: "simple-workflow" };
      const { serializeTask } = await import("../../../src/store/task-store.js");
      const writeFileAtomic = (await import("write-file-atomic")).default;
      const taskPath = join(TEST_DATA_DIR, "tasks", task.frontmatter.status, `${task.frontmatter.id}.md`);
      await writeFileAtomic(taskPath, serializeTask(task));

      // Empty rejectionNotes should also fail
      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Found issues",
          outcome: "needs_review",
          blockers: ["Missing tests"],
          rejectionNotes: "   ", // Only whitespace
        })
      ).rejects.toThrow(/When rejecting work \(needs_review\), you must provide rejectionNotes/);
    });
  });

  describe("Scenario 4: blocked without blockers", () => {
    it("should provide teaching error when blockers array is missing", async () => {
      const task = await store.create({
        title: "Test task",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const projectYaml = `
id: test
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: test-agent
workflow:
  name: simple-workflow
  gates:
    - id: dev
      role: swe-backend
      canReject: false
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      task.frontmatter.gate = { current: "dev", entered: new Date().toISOString() };
      task.frontmatter.routing = { role: "swe-backend", workflow: "simple-workflow" };
      const { serializeTask } = await import("../../../src/store/task-store.js");
      const writeFileAtomic = (await import("write-file-atomic")).default;
      const taskPath = join(TEST_DATA_DIR, "tasks", task.frontmatter.status, `${task.frontmatter.id}.md`);
      await writeFileAtomic(taskPath, serializeTask(task));

      // Try blocked without blockers
      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Blocked on dependency",
          outcome: "blocked",
          // blockers missing
        })
      ).rejects.toThrow(/When marking blocked, provide a blockers array/);

      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Blocked on dependency",
          outcome: "blocked",
        })
      ).rejects.toThrow(/listing what's preventing progress/);
    });

    it("should provide teaching error when blockers array is empty", async () => {
      const task = await store.create({
        title: "Test task",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const projectYaml = `
id: test
title: Test Project
type: swe
status: active
owner:
  team: eng
  lead: test-agent
workflow:
  name: simple-workflow
  gates:
    - id: dev
      role: swe-backend
      canReject: false
`;
      await mkdir(join(TEST_DATA_DIR, ".git"), { recursive: true });
      await writeFile(join(TEST_DATA_DIR, "project.yaml"), projectYaml);

      task.frontmatter.gate = { current: "dev", entered: new Date().toISOString() };
      task.frontmatter.routing = { role: "swe-backend", workflow: "simple-workflow" };
      const { serializeTask } = await import("../../../src/store/task-store.js");
      const writeFileAtomic = (await import("write-file-atomic")).default;
      const taskPath = join(TEST_DATA_DIR, "tasks", task.frontmatter.status, `${task.frontmatter.id}.md`);
      await writeFileAtomic(taskPath, serializeTask(task));

      // Empty blockers array should fail
      await expect(
        aofTaskComplete(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
          summary: "Blocked on dependency",
          outcome: "blocked",
          blockers: [], // Empty array
        })
      ).rejects.toThrow(/When marking blocked, provide a blockers array/);
    });
  });

  describe("Scenario 5: Graceful fallback for non-workflow tasks", () => {
    it("should complete task normally when no workflow but outcome provided", async () => {
      const task = await store.create({
        title: "Legacy task",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // No gate workflow, but agent sends outcome
      // Should gracefully ignore outcome and complete normally
      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
        summary: "Completed",
        outcome: "complete", // Ignored for non-workflow tasks
      });

      expect(result.status).toBe("done");
      expect(result.taskId).toBe(task.frontmatter.id);
    });

    it("should handle non-workflow task with outcome and blockers gracefully", async () => {
      const task = await store.create({
        title: "Legacy task with params",
        body: "# Work",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // No workflow, but agent sends outcome and blockers
      // Should complete normally and ignore workflow parameters
      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
        summary: "Completed",
        outcome: "complete",
        blockers: ["Some blocker"], // Should be ignored
      });

      expect(result.status).toBe("done");
    });
  });
});
