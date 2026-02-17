/**
 * E2E Test Suite 16: New Task Management Tools
 * 
 * Tests newly added task management operations:
 * - aof_task_edit — edit task metadata (title, description, priority, routing)
 * - aof_task_cancel — cancel a task with optional reason
 * - aof_task_dep_add — add task dependency
 * - aof_task_dep_remove — remove task dependency
 * - aof_task_block — block a task with reason
 * - aof_task_unblock — unblock a task
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { EventLogger } from "../../../src/events/logger.js";
import { 
  aofTaskEdit,
  aofTaskCancel,
  aofTaskDepAdd,
  aofTaskDepRemove,
  aofTaskBlock,
  aofTaskUnblock,
  type ToolContext 
} from "../../../src/tools/aof-tools.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "new-task-tools");

describe("E2E: New Task Management Tools", () => {
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

  describe("aof_task_edit", () => {
    it("should edit task title", async () => {
      const task = await store.create({
        title: "Original Title",
        body: "Task body",
        createdBy: "system",
      });

      const result = await aofTaskEdit(ctx, {
        taskId: task.frontmatter.id,
        title: "Updated Title",
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.updatedFields).toContain("title");
      expect(result.task.title).toBe("Updated Title");

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.title).toBe("Updated Title");
    });

    it("should edit task description", async () => {
      const task = await store.create({
        title: "Test Task",
        body: "Original description",
        createdBy: "system",
      });

      const result = await aofTaskEdit(ctx, {
        taskId: task.frontmatter.id,
        description: "Updated description",
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.updatedFields).toContain("description");

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.body).toBe("Updated description");
    });

    it("should edit task priority", async () => {
      const task = await store.create({
        title: "Test Task",
        priority: "normal",
        createdBy: "system",
      });

      const result = await aofTaskEdit(ctx, {
        taskId: task.frontmatter.id,
        priority: "high",
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.updatedFields).toContain("priority");
      expect(result.task.priority).toBe("high");

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.priority).toBe("high");
    });

    it("should edit task routing fields", async () => {
      const task = await store.create({
        title: "Test Task",
        createdBy: "system",
      });

      const result = await aofTaskEdit(ctx, {
        taskId: task.frontmatter.id,
        routing: {
          agent: "swe-backend",
          team: "platform",
          tags: ["backend", "critical"],
        },
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.updatedFields).toContain("routing");

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.routing.agent).toBe("swe-backend");
      expect(updated?.frontmatter.routing.team).toBe("platform");
      expect(updated?.frontmatter.routing.tags).toEqual(["backend", "critical"]);
    });

    it("should edit multiple fields at once", async () => {
      const task = await store.create({
        title: "Original Title",
        body: "Original body",
        priority: "normal",
        createdBy: "system",
      });

      const result = await aofTaskEdit(ctx, {
        taskId: task.frontmatter.id,
        title: "New Title",
        description: "New description",
        priority: "critical",
        actor: "test-agent",
      });

      expect(result.updatedFields).toEqual(["title", "description", "priority"]);
      expect(result.task.title).toBe("New Title");
      expect(result.task.priority).toBe("critical");

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.title).toBe("New Title");
      expect(updated?.body).toBe("New description");
      expect(updated?.frontmatter.priority).toBe("critical");
    });

    it("should throw error if no fields provided", async () => {
      const task = await store.create({
        title: "Test Task",
        createdBy: "system",
      });

      await expect(
        aofTaskEdit(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
        })
      ).rejects.toThrow(/No fields to update/);
    });

    it("should resolve task by prefix", async () => {
      const task = await store.create({
        title: "Prefix Test",
        createdBy: "system",
      });

      const prefix = task.frontmatter.id.substring(0, 12);
      const result = await aofTaskEdit(ctx, {
        taskId: prefix,
        title: "Updated via prefix",
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
    });
  });

  describe("aof_task_cancel", () => {
    it("should cancel a task with reason", async () => {
      const task = await store.create({
        title: "Task to Cancel",
        createdBy: "system",
      });

      const result = await aofTaskCancel(ctx, {
        taskId: task.frontmatter.id,
        reason: "No longer needed",
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("cancelled");
      expect(result.reason).toBe("No longer needed");

      const cancelled = await store.get(task.frontmatter.id);
      expect(cancelled?.frontmatter.status).toBe("cancelled");
    });

    it("should cancel a task without reason", async () => {
      const task = await store.create({
        title: "Task to Cancel",
        createdBy: "system",
      });

      const result = await aofTaskCancel(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("cancelled");
      expect(result.reason).toBeUndefined();
    });

    it("should resolve task by prefix", async () => {
      const task = await store.create({
        title: "Cancel by Prefix",
        createdBy: "system",
      });

      const prefix = task.frontmatter.id.substring(0, 12);
      const result = await aofTaskCancel(ctx, {
        taskId: prefix,
        reason: "Cancelled via prefix",
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("cancelled");
    });
  });

  describe("aof_task_dep_add", () => {
    it("should add a dependency between two tasks", async () => {
      const blocker = await store.create({
        title: "Blocker Task",
        createdBy: "system",
      });

      const dependent = await store.create({
        title: "Dependent Task",
        createdBy: "system",
      });

      const result = await aofTaskDepAdd(ctx, {
        taskId: dependent.frontmatter.id,
        blockerId: blocker.frontmatter.id,
        actor: "test-agent",
      });

      expect(result.taskId).toBe(dependent.frontmatter.id);
      expect(result.blockerId).toBe(blocker.frontmatter.id);
      expect(result.dependsOn).toContain(blocker.frontmatter.id);

      const updated = await store.get(dependent.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toContain(blocker.frontmatter.id);
    });

    it("should throw error if blocker task does not exist", async () => {
      const task = await store.create({
        title: "Task",
        createdBy: "system",
      });

      await expect(
        aofTaskDepAdd(ctx, {
          taskId: task.frontmatter.id,
          blockerId: "TASK-9999-99-99-999",
          actor: "test-agent",
        })
      ).rejects.toThrow(/not found/);
    });
  });

  describe("aof_task_dep_remove", () => {
    it("should remove a dependency between two tasks", async () => {
      const blocker = await store.create({
        title: "Blocker Task",
        createdBy: "system",
      });

      const dependent = await store.create({
        title: "Dependent Task",
        createdBy: "system",
      });

      // First add the dependency
      await store.addDep(dependent.frontmatter.id, blocker.frontmatter.id);

      // Verify it was added
      let task = await store.get(dependent.frontmatter.id);
      expect(task?.frontmatter.dependsOn).toContain(blocker.frontmatter.id);

      // Now remove it
      const result = await aofTaskDepRemove(ctx, {
        taskId: dependent.frontmatter.id,
        blockerId: blocker.frontmatter.id,
        actor: "test-agent",
      });

      expect(result.taskId).toBe(dependent.frontmatter.id);
      expect(result.blockerId).toBe(blocker.frontmatter.id);
      expect(result.dependsOn).not.toContain(blocker.frontmatter.id);

      const updated = await store.get(dependent.frontmatter.id);
      expect(updated?.frontmatter.dependsOn ?? []).not.toContain(blocker.frontmatter.id);
    });
  });

  describe("aof_task_block", () => {
    it("should block a task with reason", async () => {
      const task = await store.create({
        title: "Task to Block",
        createdBy: "system",
      });

      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const result = await aofTaskBlock(ctx, {
        taskId: task.frontmatter.id,
        reason: "Waiting for API spec",
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("Waiting for API spec");

      const blocked = await store.get(task.frontmatter.id);
      expect(blocked?.frontmatter.status).toBe("blocked");
    });

    it("should throw error if reason is missing", async () => {
      const task = await store.create({
        title: "Task to Block",
        createdBy: "system",
      });

      await expect(
        aofTaskBlock(ctx, {
          taskId: task.frontmatter.id,
          reason: "",
          actor: "test-agent",
        })
      ).rejects.toThrow(/Block reason is required/);
    });

    it("should throw error if reason is only whitespace", async () => {
      const task = await store.create({
        title: "Task to Block",
        createdBy: "system",
      });

      await expect(
        aofTaskBlock(ctx, {
          taskId: task.frontmatter.id,
          reason: "   ",
          actor: "test-agent",
        })
      ).rejects.toThrow(/Block reason is required/);
    });

    it("should resolve task by prefix", async () => {
      const task = await store.create({
        title: "Block by Prefix",
        createdBy: "system",
      });

      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");

      const prefix = task.frontmatter.id.substring(0, 12);
      const result = await aofTaskBlock(ctx, {
        taskId: prefix,
        reason: "Blocked via prefix",
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("blocked");
    });
  });

  describe("aof_task_unblock", () => {
    it("should unblock a blocked task", async () => {
      const task = await store.create({
        title: "Task to Unblock",
        createdBy: "system",
      });

      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.block(task.frontmatter.id, "Blocked for testing");

      // Verify it's blocked
      let blocked = await store.get(task.frontmatter.id);
      expect(blocked?.frontmatter.status).toBe("blocked");

      // Unblock it
      const result = await aofTaskUnblock(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("ready");

      const unblocked = await store.get(task.frontmatter.id);
      expect(unblocked?.frontmatter.status).toBe("ready");
    });

    it("should resolve task by prefix", async () => {
      const task = await store.create({
        title: "Unblock by Prefix",
        createdBy: "system",
      });

      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.block(task.frontmatter.id, "Test block");

      const prefix = task.frontmatter.id.substring(0, 12);
      const result = await aofTaskUnblock(ctx, {
        taskId: prefix,
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("ready");
    });

    it("should throw error if task is not blocked", async () => {
      const task = await store.create({
        title: "Non-blocked Task",
        createdBy: "system",
      });

      await expect(
        aofTaskUnblock(ctx, {
          taskId: task.frontmatter.id,
          actor: "test-agent",
        })
      ).rejects.toThrow();
    });
  });

  describe("envelope format validation", () => {
    it("should have consistent envelope structure across all new tools", async () => {
      // Create test tasks
      const task1 = await store.create({ title: "Edit Test", createdBy: "system" });
      const task2 = await store.create({ title: "Cancel Test", createdBy: "system" });
      const task3 = await store.create({ title: "Dep Test", createdBy: "system" });
      const blocker = await store.create({ title: "Blocker", createdBy: "system" });
      const task4 = await store.create({ title: "Block Test", createdBy: "system" });
      await store.transition(task4.frontmatter.id, "ready");
      await store.transition(task4.frontmatter.id, "in-progress");
      await store.block(task4.frontmatter.id, "Test");
      const task5 = await store.create({ title: "Unblock Test", createdBy: "system" });
      await store.transition(task5.frontmatter.id, "ready");
      await store.transition(task5.frontmatter.id, "in-progress");
      await store.block(task5.frontmatter.id, "Test");

      // Test aofTaskEdit envelope
      const editResult = await aofTaskEdit(ctx, {
        taskId: task1.frontmatter.id,
        title: "Updated",
        actor: "test",
      });
      expect(editResult.summary).toBeDefined();
      expect(typeof editResult.summary).toBe("string");

      // Test aofTaskCancel envelope
      const cancelResult = await aofTaskCancel(ctx, {
        taskId: task2.frontmatter.id,
        actor: "test",
      });
      expect(cancelResult.summary).toBeDefined();
      expect(typeof cancelResult.summary).toBe("string");

      // Test aofTaskDepAdd envelope
      const depAddResult = await aofTaskDepAdd(ctx, {
        taskId: task3.frontmatter.id,
        blockerId: blocker.frontmatter.id,
        actor: "test",
      });
      expect(depAddResult.summary).toBeDefined();
      expect(typeof depAddResult.summary).toBe("string");

      // Test aofTaskDepRemove envelope
      const depRemoveResult = await aofTaskDepRemove(ctx, {
        taskId: task3.frontmatter.id,
        blockerId: blocker.frontmatter.id,
        actor: "test",
      });
      expect(depRemoveResult.summary).toBeDefined();
      expect(typeof depRemoveResult.summary).toBe("string");

      // Test aofTaskBlock envelope
      // First unblock task4 if it was already blocked, then block it again
      const task4Status = (await store.get(task4.frontmatter.id))?.frontmatter.status;
      if (task4Status === "blocked") {
        await store.unblock(task4.frontmatter.id);
        await store.transition(task4.frontmatter.id, "in-progress");
      }
      const blockResult = await aofTaskBlock(ctx, {
        taskId: task4.frontmatter.id,
        reason: "Test block",
        actor: "test",
      });
      expect(blockResult.summary).toBeDefined();
      expect(typeof blockResult.summary).toBe("string");

      // Test aofTaskUnblock envelope
      const unblockResult = await aofTaskUnblock(ctx, {
        taskId: task5.frontmatter.id,
        actor: "test",
      });
      expect(unblockResult.summary).toBeDefined();
      expect(typeof unblockResult.summary).toBe("string");
    });
  });
});
