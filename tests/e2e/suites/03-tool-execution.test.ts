/**
 * E2E Test Suite 3: Tool Execution
 * 
 * Tests AOF tool functions against real task store state:
 * - aof_task_update — update task status and body
 * - aof_task_complete — mark task complete with outputs
 * - aof_status_report — generate status reports (compact and full modes)
 * - Verify envelope format from CTX-003
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { EventLogger } from "../../../src/events/logger.js";
import { aofDispatch, aofTaskUpdate, aofTaskComplete, aofStatusReport, type ToolContext } from "../../../src/tools/aof-tools.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile } from "node:fs/promises";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "tool-execution");

describe("E2E: Tool Execution", () => {
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

  describe("aof_dispatch", () => {
    it("should create a new task with required fields", async () => {
      const result = await aofDispatch(ctx, {
        title: "New dispatched task",
        brief: "Task created via aof_dispatch tool",
        actor: "test-agent",
      });

      // Verify envelope structure
      expect(result.summary).toBeDefined();
      expect(typeof result.summary).toBe("string");
      expect(result.taskId).toBeDefined();
      expect(result.taskId).toMatch(/^TASK-\d{4}-\d{2}-\d{2}-\d{3}$/);
      expect(result.status).toBe("ready");
      expect(result.filePath).toBeDefined();

      // Verify task was actually created
      const task = await store.get(result.taskId);
      expect(task).toBeDefined();
      expect(task?.frontmatter.title).toBe("New dispatched task");
      expect(task?.frontmatter.status).toBe("ready");
      expect(task?.body).toContain("Task created via aof_dispatch tool");
    });

    it("should create task with routing (agent)", async () => {
      const result = await aofDispatch(ctx, {
        title: "Task with routing",
        brief: "Assigned to specific agent",
        agent: "swe-backend",
        actor: "test-agent",
      });

      expect(result.taskId).toBeDefined();
      expect(result.status).toBe("ready");

      const task = await store.get(result.taskId);
      expect(task?.frontmatter.routing.agent).toBe("swe-backend");
    });

    it("should create task with priority", async () => {
      const result = await aofDispatch(ctx, {
        title: "High priority task",
        brief: "Urgent work",
        priority: "high",
        actor: "test-agent",
      });

      expect(result.taskId).toBeDefined();

      const task = await store.get(result.taskId);
      expect(task?.frontmatter.priority).toBe("high");
    });

    it("should create task with metadata (tags)", async () => {
      const result = await aofDispatch(ctx, {
        title: "Task with metadata",
        brief: "Has tags",
        metadata: { tags: ["bug", "critical"], type: "bugfix" },
        actor: "test-agent",
      });

      expect(result.taskId).toBeDefined();

      const task = await store.get(result.taskId);
      expect(task?.frontmatter.metadata?.tags).toEqual(["bug", "critical"]);
      expect(task?.frontmatter.metadata?.type).toBe("bugfix");
    });

    it("should create task with dependsOn", async () => {
      // Create a parent task first
      const parentTask = await store.create({
        title: "Parent task",
        body: "Parent work",
        createdBy: "system",
      });

      const result = await aofDispatch(ctx, {
        title: "Dependent task",
        brief: "Depends on parent",
        dependsOn: [parentTask.frontmatter.id],
        actor: "test-agent",
      });

      expect(result.taskId).toBeDefined();

      const task = await store.get(result.taskId);
      expect(task?.frontmatter.dependsOn).toEqual([parentTask.frontmatter.id]);
    });

    it("should create task with parentId", async () => {
      // Create a parent task first
      const parentTask = await store.create({
        title: "Parent epic",
        body: "Parent work",
        createdBy: "system",
      });

      const result = await aofDispatch(ctx, {
        title: "Subtask",
        brief: "Child of parent epic",
        parentId: parentTask.frontmatter.id,
        actor: "test-agent",
      });

      expect(result.taskId).toBeDefined();

      const task = await store.get(result.taskId);
      expect(task?.frontmatter.parentId).toBe(parentTask.frontmatter.id);
    });

    it("should place created task in tasks/ready/ directory", async () => {
      const result = await aofDispatch(ctx, {
        title: "Task for file check",
        brief: "Verify file location",
        actor: "test-agent",
      });

      expect(result.filePath).toContain("tasks/ready/");
      
      // Verify file exists at the expected location
      const expectedPath = join(TEST_DATA_DIR, "tasks", "ready", `${result.taskId}.md`);
      const fileContent = await readFile(expectedPath, "utf-8");
      expect(fileContent).toContain("Task for file check");
    });

    it("should log task.created event", async () => {
      const result = await aofDispatch(ctx, {
        title: "Event logging test",
        brief: "Check event log",
        actor: "test-agent",
      });

      // Read event log and verify task.created event
      const today = new Date().toISOString().slice(0, 10);
      const eventsFile = join(TEST_DATA_DIR, "events", `${today}.jsonl`);
      const eventsContent = await readFile(eventsFile, "utf-8");
      const events = eventsContent
        .trim()
        .split("\n")
        .map(line => JSON.parse(line));
      
      const createdEvent = events.find(
        (e: any) => e.type === "task.created" && e.taskId === result.taskId
      );
      
      expect(createdEvent).toBeDefined();
      expect(createdEvent?.actor).toBe("test-agent");
    });

    it("should transition task to ready status", async () => {
      const result = await aofDispatch(ctx, {
        title: "Status transition test",
        brief: "Verify task status",
        actor: "test-agent",
      });

      expect(result.status).toBe("ready");

      const task = await store.get(result.taskId);
      expect(task?.frontmatter.status).toBe("ready");
    });

    it("should return taskId, status, and filePath in response", async () => {
      const result = await aofDispatch(ctx, {
        title: "Response envelope test",
        brief: "Check response structure",
        actor: "test-agent",
      });

      // Verify all required fields
      expect(result).toHaveProperty("taskId");
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("filePath");
      expect(result).toHaveProperty("summary");
      
      // Verify types
      expect(typeof result.taskId).toBe("string");
      expect(typeof result.status).toBe("string");
      expect(typeof result.filePath).toBe("string");
      expect(typeof result.summary).toBe("string");
    });

    it("should handle brief alias for description", async () => {
      const result = await aofDispatch(ctx, {
        title: "Brief test",
        brief: "This is the brief/description",
        actor: "test-agent",
      });

      const task = await store.get(result.taskId);
      expect(task?.body).toContain("This is the brief/description");
    });

    it("should normalize priority values", async () => {
      const result = await aofDispatch(ctx, {
        title: "Priority normalization",
        brief: "Test priority",
        priority: "critical",
        actor: "test-agent",
      });

      const task = await store.get(result.taskId);
      expect(task?.frontmatter.priority).toBe("critical");
    });

    it("should throw error if title is missing", async () => {
      await expect(
        aofDispatch(ctx, {
          title: "",
          brief: "Missing title",
          actor: "test-agent",
        })
      ).rejects.toThrow();
    });

    it("should throw error if brief is missing", async () => {
      await expect(
        aofDispatch(ctx, {
          title: "No brief",
          brief: "",
          actor: "test-agent",
        })
      ).rejects.toThrow();
    });
  });

  describe("aof_task_update", () => {
    it("should update task status", async () => {
      // Create task in backlog
      const task = await store.create({
        title: "Tool Test Task",
        body: "# Test\n\nInitial body.",
        createdBy: "system",
      });

      expect(task.frontmatter.status).toBe("backlog");

      // Update to ready status
      const result = await aofTaskUpdate(ctx, {
        taskId: task.frontmatter.id,
        status: "ready",
        actor: "test-agent",
        reason: "Ready for work",
      });

      // Verify envelope structure
      expect(result.summary).toBeDefined();
      expect(typeof result.summary).toBe("string");
      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("ready");
      expect(result.transitioned).toBe(true);
      expect(result.updatedAt).toBeDefined();

      // Verify task was actually updated
      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("ready");
    });

    it("should update task body without status change", async () => {
      const task = await store.create({
        title: "Body Update Test",
        body: "# Original\n\nOriginal content.",
        createdBy: "system",
      });

      const newBody = "# Updated\n\nNew content after tool call.";
      const result = await aofTaskUpdate(ctx, {
        taskId: task.frontmatter.id,
        body: newBody,
        actor: "test-agent",
      });

      expect(result.bodyUpdated).toBe(true);
      expect(result.transitioned).toBe(false);
      expect(result.status).toBe("backlog"); // Unchanged

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.body).toBe(newBody);
    });

    it("should update both body and status in single call", async () => {
      const task = await store.create({
        title: "Combined Update Test",
        body: "# Original",
        createdBy: "system",
      });

      const newBody = "# Updated\n\nBody and status changed.";
      const result = await aofTaskUpdate(ctx, {
        taskId: task.frontmatter.id,
        body: newBody,
        status: "ready",
        actor: "test-agent",
      });

      expect(result.bodyUpdated).toBe(true);
      expect(result.transitioned).toBe(true);
      expect(result.status).toBe("ready");

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.body).toBe(newBody);
      expect(updated?.frontmatter.status).toBe("ready");
    });

    it("should resolve task by prefix", async () => {
      const task = await store.create({
        title: "Prefix Resolution Test",
        createdBy: "system",
      });

      // Use just the prefix (e.g., "TASK-2026-02")
      const prefix = task.frontmatter.id.substring(0, 12);
      const result = await aofTaskUpdate(ctx, {
        taskId: prefix,
        status: "ready",
        actor: "test-agent",
      });

      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("ready");
    });

    it("should throw error for non-existent task", async () => {
      await expect(
        aofTaskUpdate(ctx, {
          taskId: "TASK-9999-99-99-999",
          status: "ready",
          actor: "test-agent",
        })
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("aof_task_complete", () => {
    it("should complete a task and transition to done", async () => {
      // Create task and move to review (ready for completion)
      const task = await store.create({
        title: "Task to Complete",
        body: "# Work to be done",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // Complete the task
      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
        summary: "Task completed successfully.",
      });

      // Verify envelope
      expect(result.summary).toBeDefined();
      expect(result.taskId).toBe(task.frontmatter.id);
      expect(result.status).toBe("done");

      // Verify actual status change
      const completed = await store.get(task.frontmatter.id);
      expect(completed?.frontmatter.status).toBe("done");
    });

    it("should write outputs directory when completing task", async () => {
      const task = await store.create({
        title: "Task with Outputs",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // Create outputs before completing
      const taskDir = join(TEST_DATA_DIR, "tasks", "review");
      const outputsDir = join(taskDir, task.frontmatter.id, "outputs");
      await mkdir(outputsDir, { recursive: true });
      await writeFile(join(outputsDir, "result.txt"), "Execution result");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "test-agent",
        summary: "Completed with outputs.",
      });

      expect(result.status).toBe("done");
      
      // Verify task moved to done directory (outputs should move with it)
      const completed = await store.get(task.frontmatter.id);
      expect(completed?.frontmatter.status).toBe("done");
    });

    it("should handle completing from review status", async () => {
      const task = await store.create({
        title: "Review to Done",
        createdBy: "system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      const result = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "reviewer",
      });

      expect(result.status).toBe("done");
    });
  });

  describe("aof_status_report", () => {
    it("should generate compact status report", async () => {
      // Create tasks in various statuses
      const task1 = await store.create({ title: "Backlog 1", createdBy: "system" });
      const task2 = await store.create({ title: "Backlog 2", createdBy: "system" });
      const task3 = await store.create({ title: "Ready 1", createdBy: "system" });
      await store.transition(task3.frontmatter.id, "ready");
      const task4 = await store.create({ title: "In Progress 1", createdBy: "system" });
      await store.transition(task4.frontmatter.id, "ready");
      await store.transition(task4.frontmatter.id, "in-progress");

      const result = await aofStatusReport(ctx, {
        compact: true,
        actor: "test-agent",
      });

      // Verify envelope structure
      expect(result.summary).toBeDefined();
      expect(result.total).toBeGreaterThanOrEqual(4);
      expect(result.byStatus).toBeDefined();
      expect(result.byStatus.backlog).toBeGreaterThanOrEqual(2);
      expect(result.byStatus.ready).toBeGreaterThanOrEqual(1);
      expect(result.byStatus["in-progress"]).toBeGreaterThanOrEqual(1);
      
      // Compact mode should have fewer details
      expect(result.details).toBeUndefined();
      expect(result.tasks).toBeDefined();
    });

    it("should generate full status report with details", async () => {
      const task1 = await store.create({ title: "Test Task 1", createdBy: "system" });
      const task2 = await store.create({ title: "Test Task 2", createdBy: "system" });
      await store.transition(task2.frontmatter.id, "ready");

      const result = await aofStatusReport(ctx, {
        compact: false,
        actor: "test-agent",
      });

      expect(result.summary).toBeDefined();
      expect(result.details).toBeDefined();
      expect(result.total).toBeGreaterThanOrEqual(2);
      expect(result.tasks.length).toBeGreaterThanOrEqual(2);
      
      // Verify task structure
      const task = result.tasks[0];
      expect(task.id).toBeDefined();
      expect(task.title).toBeDefined();
      expect(task.status).toBeDefined();
    });

    it("should filter status report by status", async () => {
      const task1 = await store.create({ title: "Backlog Task", createdBy: "system" });
      const task2 = await store.create({ title: "Ready Task", createdBy: "system" });
      await store.transition(task2.frontmatter.id, "ready");

      const result = await aofStatusReport(ctx, {
        status: "ready",
        actor: "test-agent",
      });

      expect(result.tasks.every(t => t.status === "ready")).toBe(true);
      expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    });

    it("should generate report with limit parameter", async () => {
      // Create several tasks
      await store.create({ title: "Task 1", createdBy: "system" });
      await store.create({ title: "Task 2", createdBy: "system" });
      await store.create({ title: "Task 3", createdBy: "system" });
      await store.create({ title: "Task 4", createdBy: "system" });
      await store.create({ title: "Task 5", createdBy: "system" });

      const result = await aofStatusReport(ctx, {
        limit: 3,
        actor: "test-agent",
      });

      // Note: limit affects details string, not tasks array length
      // The full report structure is still returned with all tasks
      expect(result.total).toBeGreaterThanOrEqual(5);
      expect(result.tasks.length).toBeGreaterThanOrEqual(5);
      expect(result.details).toBeDefined(); // Details should be limited
    });
  });

  describe("envelope format validation", () => {
    it("should have consistent envelope structure across all tools", async () => {
      const task = await store.create({
        title: "Envelope Test",
        createdBy: "system",
      });

      // Test aofTaskUpdate envelope
      const updateResult = await aofTaskUpdate(ctx, {
        taskId: task.frontmatter.id,
        status: "ready",
        actor: "test",
      });
      expect(updateResult.summary).toBeDefined();
      expect(typeof updateResult.summary).toBe("string");

      // Test aofStatusReport envelope
      const reportResult = await aofStatusReport(ctx, { actor: "test" });
      expect(reportResult.summary).toBeDefined();
      expect(typeof reportResult.summary).toBe("string");

      // Move to review for completion test
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      // Test aofTaskComplete envelope
      const completeResult = await aofTaskComplete(ctx, {
        taskId: task.frontmatter.id,
        actor: "test",
      });
      expect(completeResult.summary).toBeDefined();
      expect(typeof completeResult.summary).toBe("string");
    });

    it("should include optional meta field when present", async () => {
      const task = await store.create({
        title: "Meta Test",
        createdBy: "system",
      });

      const result = await aofTaskUpdate(ctx, {
        taskId: task.frontmatter.id,
        status: "ready",
        actor: "test",
      });

      // Meta should include taskId and status
      expect(result.meta).toBeDefined();
      expect(result.meta?.taskId).toBe(task.frontmatter.id);
      expect(result.meta?.status).toBe("ready");
    });
  });
});
