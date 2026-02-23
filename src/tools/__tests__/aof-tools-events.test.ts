/**
 * BUG-002 Integration Tests: Tool event emission
 * 
 * Tests that AOF tools properly emit events through the logger.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofDispatch, aofTaskUpdate, aofTaskComplete } from "../aof-tools.js";
import { readTasksInDir } from "../../testing/task-reader.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-002: AOF tool event emission", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let capturedEvents: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-tool-events-"));
    capturedEvents = [];
    
    // Create EventLogger with callback
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => {
        capturedEvents.push(event);
      },
    });
    
    // Create TaskStore with transition hook
    store = new FilesystemTaskStore(tmpDir, {
      hooks: {
        afterTransition: async (task, previousStatus) => {
          await logger.logTransition(
            task.frontmatter.id,
            previousStatus,
            task.frontmatter.status,
            "test-actor",
            "tool-transition"
          );
        },
      },
    });
    
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("aofDispatch emits task.created and task.transitioned events", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "Test Task",
        brief: "Test brief",
        actor: "test-actor",
      }
    );

    expect(result.taskId).toBeDefined();
    
    // Should have task.created event
    const createdEvents = capturedEvents.filter(e => e.type === "task.created");
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]?.taskId).toBe(result.taskId);
    
    // Should have transition events (backlog → ready)
    const transitionEvents = capturedEvents.filter(e => e.type === "task.transitioned");
    expect(transitionEvents.length).toBeGreaterThan(0);
    
    const backlogToReady = transitionEvents.find(
      e => e.payload.from === "backlog" && e.payload.to === "ready"
    );
    expect(backlogToReady).toBeDefined();
  });

  it("aofTaskUpdate emits task.transitioned event when status changes", async () => {
    // Create a task first
    const createResult = await aofDispatch(
      { store, logger },
      {
        title: "Update Test",
        brief: "Test",
        actor: "test-actor",
      }
    );

    // Clear events from dispatch
    capturedEvents.length = 0;

    // Update task status
    await aofTaskUpdate(
      { store, logger },
      {
        taskId: createResult.taskId,
        status: "in-progress",
        actor: "test-actor",
      }
    );

    // Should have transition event (ready → in-progress)
    const transitionEvents = capturedEvents.filter(e => e.type === "task.transitioned");
    expect(transitionEvents.length).toBeGreaterThan(0);
    
    const readyToInProgress = transitionEvents.find(
      e => e.payload.from === "ready" && e.payload.to === "in-progress"
    );
    expect(readyToInProgress).toBeDefined();
  });

  it("aofTaskComplete emits task.completed and task.transitioned events", async () => {
    // Create a task and move it to review (so it can go to done)
    const createResult = await aofDispatch(
      { store, logger },
      {
        title: "Complete Test",
        brief: "Test",
        actor: "test-actor",
      }
    );

    await store.transition(createResult.taskId, "in-progress");
    await store.transition(createResult.taskId, "review");

    // Clear events
    capturedEvents.length = 0;

    // Complete the task
    await aofTaskComplete(
      { store, logger },
      {
        taskId: createResult.taskId,
        actor: "test-actor",
        summary: "Task completed successfully",
      }
    );

    // Should have task.completed event
    const completedEvents = capturedEvents.filter(e => e.type === "task.completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.taskId).toBe(createResult.taskId);
    
    // Should have transition event (review → done)
    const transitionEvents = capturedEvents.filter(e => e.type === "task.transitioned");
    const reviewToDone = transitionEvents.find(
      e => e.payload.from === "review" && e.payload.to === "done"
    );
    expect(reviewToDone).toBeDefined();
  });

  it("no events emitted on tool failure", async () => {
    capturedEvents.length = 0;

    // Try to update non-existent task
    await expect(
      aofTaskUpdate(
        { store, logger },
        {
          taskId: "TASK-9999-12-31-999",
          body: "Should fail",
          actor: "test-actor",
        }
      )
    ).rejects.toThrow();

    // No events should be captured
    expect(capturedEvents).toHaveLength(0);
  });

  it("ODD filesystem: task in ready dir after aofDispatch", async () => {
    const result = await aofDispatch(
      { store, logger },
      { title: "FS Test Task", brief: "ODD filesystem check", actor: "test-actor" }
    );

    // ODD: filesystem state — task exists in tasks/ready/
    const readyTasks = await readTasksInDir(join(tmpDir, "tasks", "ready"));
    const found = readyTasks.find(t => t.frontmatter.id === result.taskId);
    expect(found).toBeDefined();
    expect(found?.frontmatter.status).toBe("ready");
  });

  it("ODD filesystem: task in in-progress dir after aofTaskUpdate", async () => {
    const { taskId } = await aofDispatch(
      { store, logger },
      { title: "FS Update Task", brief: "ODD update check", actor: "test-actor" }
    );
    capturedEvents.length = 0;

    await aofTaskUpdate({ store, logger }, { taskId, status: "in-progress", actor: "test-actor" });

    // ODD: filesystem state — task moved to tasks/in-progress/
    const inProgressTasks = await readTasksInDir(join(tmpDir, "tasks", "in-progress"));
    const found = inProgressTasks.find(t => t.frontmatter.id === taskId);
    expect(found).toBeDefined();
    expect(found?.frontmatter.status).toBe("in-progress");
  });

  it("ODD filesystem: task in done dir after aofTaskComplete", async () => {
    const { taskId } = await aofDispatch(
      { store, logger },
      { title: "FS Complete Task", brief: "ODD complete check", actor: "test-actor" }
    );
    await store.transition(taskId, "in-progress");
    await store.transition(taskId, "review");
    capturedEvents.length = 0;

    await aofTaskComplete(
      { store, logger },
      { taskId, actor: "test-actor", summary: "All done" }
    );

    // ODD: filesystem state — task in tasks/done/
    const doneTasks = await readTasksInDir(join(tmpDir, "tasks", "done"));
    const found = doneTasks.find(t => t.frontmatter.id === taskId);
    expect(found).toBeDefined();
    expect(found?.frontmatter.status).toBe("done");
  });

  it("ODD event+filesystem: aofDispatch with routing persists agent metadata", async () => {
    const result = await aofDispatch(
      { store, logger },
      {
        title: "Routed Task",
        brief: "Route to specific agent",
        actor: "test-actor",
        agent: "swe-backend",
      }
    );

    // ODD event: task.created event carries routing
    const createdEvent = capturedEvents.find(e => e.type === "task.created");
    expect(createdEvent?.taskId).toBe(result.taskId);

    // ODD filesystem: task file has correct routing
    const readyTasks = await readTasksInDir(join(tmpDir, "tasks", "ready"));
    const task = readyTasks.find(t => t.frontmatter.id === result.taskId);
    expect(task?.frontmatter.routing?.agent).toBe("swe-backend");
  });
});
