/**
 * BUG-005 Regression Tests — Tool Invocations with Artifacts
 * 
 * Verifies that aof_dispatch and aof_task_update produce persisted
 * task files on disk (not just in-memory operations).
 * 
 * These tests run against real filesystem (tmpdir) to catch regressions
 * where dryRun=true or similar configuration prevents persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofDispatch, aofTaskUpdate } from "../../tools/aof-tools.js";

describe("BUG-005 Regression: Tool Persistence", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug005-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("aof_dispatch persistence", () => {
    it("creates a task file on disk after dispatch", async () => {
      // Dispatch a new task via tool
      const result = await aofDispatch(
        { store, logger },
        {
          title: "BUG-005 Dispatch Test",
          brief: "Verify file creation on disk",
          agent: "test-agent",
          actor: "bug-005-test",
        }
      );

      expect(result.taskId).toBeDefined();
      expect(result.status).toBe("ready");

      // Verify task file exists on disk
      const taskPath = join(tmpDir, "tasks", "ready", `${result.taskId}.md`);
      const content = await readFile(taskPath, "utf-8");

      expect(content).toContain("BUG-005 Dispatch Test");
      expect(content).toContain("status: ready");
      expect(content).toContain("Verify file creation on disk");
    });

    it("creates task directory structure on disk", async () => {
      const result = await aofDispatch(
        { store, logger },
        {
          title: "Directory structure test",
          brief: "Check all dirs",
          agent: "test-agent",
          actor: "test",
        }
      );

      // Verify directory structure exists
      const baseDir = join(tmpDir, "tasks", "ready", result.taskId);
      const entries = await readdir(baseDir);

      // Directory contains: inputs, work, outputs, subtasks
      expect(entries).toContain("inputs");
      expect(entries).toContain("work");
      expect(entries).toContain("outputs");
      expect(entries).toContain("subtasks");
    });

    it("persists routing information to disk", async () => {
      const result = await aofDispatch(
        { store, logger },
        {
          title: "Routing test",
          brief: "Check routing",
          agent: "swe-backend",
          team: "engineering",
          actor: "test",
        }
      );

      const taskContent = await readFile(
        join(tmpDir, "tasks", "ready", `${result.taskId}.md`),
        "utf-8"
      );

      expect(taskContent).toContain("routing:");
      expect(taskContent).toContain("agent: swe-backend");
      expect(taskContent).toContain("team: engineering");
    });

    it("persists priority to disk", async () => {
      const result = await aofDispatch(
        { store, logger },
        {
          title: "Priority test",
          brief: "Check priority",
          priority: "high",
          actor: "test",
        }
      );

      const content = await readFile(
        join(tmpDir, "tasks", "ready", `${result.taskId}.md`),
        "utf-8"
      );

      expect(content).toContain("priority: high");
    });

    it("persists metadata to disk", async () => {
      const result = await aofDispatch(
        { store, logger },
        {
          title: "Metadata test",
          brief: "Check metadata",
          metadata: { customField: "value123", projectId: "proj-001" },
          tags: ["bug", "p0"],
          actor: "test",
        }
      );

      const content = await readFile(
        join(tmpDir, "tasks", "ready", `${result.taskId}.md`),
        "utf-8"
      );

      expect(content).toContain("metadata:");
      expect(content).toContain("customField: value123");
      expect(content).toContain("bug");
      expect(content).toContain("p0");
    });
  });

  describe("aof_task_update persistence", () => {
    it("updates task status on disk", async () => {
      // Create initial task
      const createResult = await aofDispatch(
        { store, logger },
        {
          title: "Status update test",
          brief: "Original body",
          agent: "test-agent",
          actor: "test",
        }
      );

      // Update status
      const updateResult = await aofTaskUpdate(
        { store, logger },
        {
          taskId: createResult.taskId,
          status: "in-progress",
          actor: "test",
        }
      );

      expect(updateResult.transitioned).toBe(true);

      // Verify file moved to new status directory
      const content = await readFile(
        join(tmpDir, "tasks", "in-progress", `${createResult.taskId}.md`),
        "utf-8"
      );

      expect(content).toContain("status: in-progress");
    });

    it("persists body modifications to disk", async () => {
      const createResult = await aofDispatch(
        { store, logger },
        {
          title: "Body update test",
          brief: "Original content",
          actor: "test",
        }
      );

      await aofTaskUpdate(
        { store, logger },
        {
          taskId: createResult.taskId,
          body: "Updated content with new information",
          actor: "test",
        }
      );

      const content = await readFile(
        join(tmpDir, "tasks", "ready", `${createResult.taskId}.md`),
        "utf-8"
      );

      expect(content).toContain("Updated content with new information");
    });

    it("persists both status and body changes", async () => {
      const createResult = await aofDispatch(
        { store, logger },
        {
          title: "Combined update test",
          brief: "Original",
          actor: "test",
        }
      );

      await aofTaskUpdate(
        { store, logger },
        {
          taskId: createResult.taskId,
          body: "Updated body",
          status: "in-progress",
          reason: "starting work",
          actor: "test-agent",
        }
      );

      const content = await readFile(
        join(tmpDir, "tasks", "in-progress", `${createResult.taskId}.md`),
        "utf-8"
      );

      expect(content).toContain("status: in-progress");
      expect(content).toContain("Updated body");
    });

    it("updates timestamp on disk", async () => {
      const createResult = await aofDispatch(
        { store, logger },
        {
          title: "Timestamp test",
          brief: "Task body",
          actor: "test",
        }
      );

      const originalTask = await store.get(createResult.taskId);
      const originalTimestamp = originalTask!.frontmatter.updatedAt;

      // Wait to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      await aofTaskUpdate(
        { store, logger },
        {
          taskId: createResult.taskId,
          body: "Updated",
          actor: "test",
        }
      );

      const updatedTask = await store.get(createResult.taskId);
      const updatedTimestamp = updatedTask!.frontmatter.updatedAt;

      expect(updatedTimestamp).toBeDefined();
      expect(updatedTimestamp).not.toBe(originalTimestamp);
    });
  });

  describe("Multiple tool invocations", () => {
    it("handles sequential dispatches with persistence", async () => {
      // Create two tasks
      const result1 = await aofDispatch(
        { store, logger },
        {
          title: "Task 1",
          brief: "First task",
          agent: "test-agent",
          actor: "test",
        }
      );

      const result2 = await aofDispatch(
        { store, logger },
        {
          title: "Task 2",
          brief: "Second task",
          agent: "test-agent",
          actor: "test",
        }
      );

      // Verify both persisted
      const allTasks = await store.list();
      expect(allTasks).toHaveLength(2);
      expect(allTasks.map(t => t.frontmatter.id)).toContain(result1.taskId);
      expect(allTasks.map(t => t.frontmatter.id)).toContain(result2.taskId);
    });

    it("handles dispatch + update workflow with persistence", async () => {
      const createResult = await aofDispatch(
        { store, logger },
        {
          title: "Workflow test",
          brief: "Initial body",
          agent: "test-agent",
          actor: "test",
        }
      );

      await aofTaskUpdate(
        { store, logger },
        {
          taskId: createResult.taskId,
          status: "in-progress",
          body: "Made progress on task",
          actor: "test-agent",
        }
      );

      // Verify final state via store.get
      const updatedTask = await store.get(createResult.taskId);
      expect(updatedTask).toBeDefined();
      expect(updatedTask!.frontmatter.status).toBe("in-progress");
      expect(updatedTask!.body).toContain("Made progress on task");
    });

    it("handles multiple updates to same task", async () => {
      const createResult = await aofDispatch(
        { store, logger },
        {
          title: "Multi-update test",
          brief: "Version 1",
          actor: "test",
        }
      );

      await aofTaskUpdate(
        { store, logger },
        {
          taskId: createResult.taskId,
          body: "Version 2",
          actor: "test",
        }
      );

      await aofTaskUpdate(
        { store, logger },
        {
          taskId: createResult.taskId,
          body: "Version 3",
          actor: "test",
        }
      );

      const updatedTask = await store.get(createResult.taskId);
      expect(updatedTask).toBeDefined();
      expect(updatedTask!.body).toContain("Version 3");
      expect(updatedTask!.body).not.toContain("Version 2");
      expect(updatedTask!.body).not.toContain("Version 1");
    });
  });

  describe("Event logging persistence", () => {
    it("logs task.created event to disk", async () => {
      await aofDispatch(
        { store, logger },
        {
          title: "Event log test",
          brief: "Check events",
          actor: "test",
        }
      );

      // Check event log file exists
      const today = new Date().toISOString().slice(0, 10);
      const eventFiles = await readdir(join(tmpDir, "events"));
      expect(eventFiles).toContain(`${today}.jsonl`);

      const eventContent = await readFile(
        join(tmpDir, "events", `${today}.jsonl`),
        "utf-8"
      );
      expect(eventContent).toContain("task.created");
      expect(eventContent).toContain("Event log test");
    });

    it("logs task transitions to disk", async () => {
      const createResult = await aofDispatch(
        { store, logger },
        {
          title: "Transition event test",
          brief: "Check transition events",
          actor: "test",
        }
      );

      await aofTaskUpdate(
        { store, logger },
        {
          taskId: createResult.taskId,
          status: "in-progress",
          actor: "test-agent",
        }
      );

      const today = new Date().toISOString().slice(0, 10);
      const eventContent = await readFile(
        join(tmpDir, "events", `${today}.jsonl`),
        "utf-8"
      );
      expect(eventContent).toContain("task.transition");
      expect(eventContent).toContain("in-progress");
    });
  });

  describe("Error conditions", () => {
    it("fails gracefully when updating non-existent task", async () => {
      await expect(
        aofTaskUpdate(
          { store, logger },
          {
            taskId: "TASK-9999-99-99-999",
            body: "Update attempt",
            actor: "test",
          }
        )
      ).rejects.toThrow(/not found/i);
    });

    it("validates required fields for dispatch", async () => {
      await expect(
        aofDispatch(
          { store, logger },
          {
            title: "",
            brief: "Test",
            actor: "test",
          }
        )
      ).rejects.toThrow(/title.*required/i);

      await expect(
        aofDispatch(
          { store, logger },
          {
            title: "Test",
            brief: "",
            actor: "test",
          }
        )
      ).rejects.toThrow(/brief.*required/i);
    });
  });
});
