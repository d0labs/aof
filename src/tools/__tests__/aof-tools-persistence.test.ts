/**
 * BUG-003 Regression Tests: Tool persistence to datastore
 * 
 * Tests that AOF tool operations persist to disk and are visible
 * in subsequent queries (aof_status_report).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofDispatch, aofStatusReport, aofTaskUpdate, aofTaskComplete } from "../aof-tools.js";

describe("BUG-003: AOF tool persistence", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug003-"));
    logger = new EventLogger(join(tmpDir, "events"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("aofDispatch creates task file on disk", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "Persistence Test",
        brief: "Test task creation",
        actor: "test-actor",
      }
    );

    expect(result.taskId).toBeDefined();
    expect(result.status).toBe("ready");
    expect(result.filePath).toBeDefined();

    // Verify file exists on disk
    const filePath = join(tmpDir, "tasks", result.status, `${result.taskId}.md`);
    const fileStats = await stat(filePath);
    expect(fileStats.isFile()).toBe(true);
  });

  it("aofDispatch creates task visible in aof_status_report", async () => {
    // Create a task
    const createResult = await aofDispatch(
      { store, logger },
      {
        title: "Status Report Test",
        brief: "Should appear in status report",
        actor: "test-actor",
      }
    );

    // Query status report
    const statusResult = await aofStatusReport({ store, logger }, {});

    expect(statusResult.total).toBe(1);
    expect(statusResult.byStatus.ready).toBe(1);
    expect(statusResult.tasks).toHaveLength(1);
    expect(statusResult.tasks[0]?.id).toBe(createResult.taskId);
    expect(statusResult.tasks[0]?.title).toBe("Status Report Test");
  });

  it("aofTaskUpdate modifies file and reflects in status report", async () => {
    // Create task
    const createResult = await aofDispatch(
      { store, logger },
      {
        title: "Update Test",
        brief: "Original brief",
        actor: "test-actor",
      }
    );

    // Update body
    const newBody = "## Updated Instructions\n\nNew content here.";
    await aofTaskUpdate(
      { store, logger },
      {
        taskId: createResult.taskId,
        body: newBody,
        actor: "test-actor",
      }
    );

    // Verify update persisted
    const task = await store.get(createResult.taskId);
    expect(task).toBeDefined();
    expect(task!.body).toContain("Updated Instructions");
    expect(task!.body).toContain("New content here");
  });

  it("aofTaskUpdate transitions status and file moves to correct directory", async () => {
    // Create task (ends up in ready/)
    const createResult = await aofDispatch(
      { store, logger },
      {
        title: "Transition Test",
        brief: "Test status transition",
        actor: "test-actor",
      }
    );

    // Transition to in-progress
    await aofTaskUpdate(
      { store, logger },
      {
        taskId: createResult.taskId,
        status: "in-progress",
        actor: "test-actor",
      }
    );

    // Verify file moved to in-progress/
    const newFilePath = join(tmpDir, "tasks", "in-progress", `${createResult.taskId}.md`);
    const fileStats = await stat(newFilePath);
    expect(fileStats.isFile()).toBe(true);

    // Verify visible in status report with correct status
    const statusResult = await aofStatusReport({ store, logger }, {});
    expect(statusResult.total).toBe(1);
    expect(statusResult.byStatus["in-progress"]).toBe(1);
    expect(statusResult.byStatus.ready).toBe(0);
  });

  it("aofTaskComplete moves task to done/ and visible in status report", async () => {
    // Create and transition task to review (so it can go to done)
    const createResult = await aofDispatch(
      { store, logger },
      {
        title: "Complete Test",
        brief: "Test completion",
        actor: "test-actor",
      }
    );

    await store.transition(createResult.taskId, "in-progress");
    await store.transition(createResult.taskId, "review");

    // Complete the task
    await aofTaskComplete(
      { store, logger },
      {
        taskId: createResult.taskId,
        summary: "All done!",
        actor: "test-actor",
      }
    );

    // Verify file in done/
    const doneFilePath = join(tmpDir, "tasks", "done", `${createResult.taskId}.md`);
    const fileStats = await stat(doneFilePath);
    expect(fileStats.isFile()).toBe(true);

    // Verify status report shows task as done
    const statusResult = await aofStatusReport({ store, logger }, {});
    expect(statusResult.total).toBe(1);
    expect(statusResult.byStatus.done).toBe(1);
    
    const doneTask = statusResult.tasks.find(t => t.id === createResult.taskId);
    expect(doneTask?.status).toBe("done");
  });

  it("multiple tool invocations accumulate in datastore", async () => {
    // Create 3 tasks
    await aofDispatch({ store, logger }, {
      title: "Task 1",
      brief: "First task",
      actor: "test-actor",
    });

    await aofDispatch({ store, logger }, {
      title: "Task 2",
      brief: "Second task",
      actor: "test-actor",
    });

    await aofDispatch({ store, logger }, {
      title: "Task 3",
      brief: "Third task",
      actor: "test-actor",
    });

    // Status report should show all 3
    const statusResult = await aofStatusReport({ store, logger }, {});
    expect(statusResult.total).toBe(3);
    expect(statusResult.byStatus.ready).toBe(3);
    expect(statusResult.tasks).toHaveLength(3);
  });

  it("status report filters by status correctly", async () => {
    // Create tasks in different statuses
    const task1 = await aofDispatch({ store, logger }, {
      title: "Ready Task",
      brief: "Stays ready",
      actor: "test-actor",
    });

    const task2 = await aofDispatch({ store, logger }, {
      title: "In Progress Task",
      brief: "Will move",
      actor: "test-actor",
    });

    await aofTaskUpdate({ store, logger }, {
      taskId: task2.taskId,
      status: "in-progress",
      actor: "test-actor",
    });

    // Filter by ready
    const readyReport = await aofStatusReport({ store, logger }, { status: "ready" });
    expect(readyReport.total).toBe(1);
    expect(readyReport.tasks[0]?.id).toBe(task1.taskId);

    // Filter by in-progress
    const inProgressReport = await aofStatusReport({ store, logger }, { status: "in-progress" });
    expect(inProgressReport.total).toBe(1);
    expect(inProgressReport.tasks[0]?.id).toBe(task2.taskId);
  });
});
