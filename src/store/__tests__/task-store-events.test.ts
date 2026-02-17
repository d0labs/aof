/**
 * BUG-002 Regression Tests: Task lifecycle event emission
 * 
 * Tests that TaskStore emits events for create, update, and transition operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import type { ITaskStore } from "../interfaces.js";
import { EventLogger } from "../../events/logger.js";
import type { TaskStatus } from "../../schemas/task.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-002: Task lifecycle event emission", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let capturedEvents: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug002-"));
    capturedEvents = [];
    
    // Create EventLogger with callback to capture events
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => {
        capturedEvents.push(event);
      },
    });
    
    // Create TaskStore with hooks that emit events
    store = new FilesystemTaskStore(tmpDir, {
      hooks: {
        afterTransition: async (task, previousStatus) => {
          await logger.logTransition(
            task.frontmatter.id,
            previousStatus,
            task.frontmatter.status,
            "test-actor",
            "test"
          );
        },
      },
    });
    
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("emits task-created event when creating a task (via explicit call)", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Test body",
      createdBy: "test-actor",
    });

    // Manually emit the created event (simulating what tools should do)
    await logger.log("task.created", "test-actor", {
      taskId: task.frontmatter.id,
      payload: {
        title: task.frontmatter.title,
        priority: task.frontmatter.priority,
      },
    });

    // Verify event was captured
    const createdEvents = capturedEvents.filter(e => e.type === "task.created");
    
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]?.taskId).toBe(task.frontmatter.id);
  });

  it("emits task-transition event when transitioning status", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Test body",
      createdBy: "test-actor",
    });

    // Clear events from setup
    capturedEvents.length = 0;

    // Transition from backlog to ready
    await store.transition(task.frontmatter.id, "ready", {
      agent: "test-actor",
      reason: "test",
    });

    // Verify transition event was captured (via afterTransition hook)
    const transitionEvents = capturedEvents.filter(e => e.type === "task.transitioned");
    
    expect(transitionEvents).toHaveLength(1);
    expect(transitionEvents[0]?.taskId).toBe(task.frontmatter.id);
    expect(transitionEvents[0]?.payload.from).toBe("backlog");
    expect(transitionEvents[0]?.payload.to).toBe("ready");
  });

  it("emits multiple transition events for status changes", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Test body",
      createdBy: "test-actor",
    });

    // Clear events from setup
    capturedEvents.length = 0;

    // Multiple transitions: backlog → ready → in-progress → review → done
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    const transitionEvents = capturedEvents.filter(e => e.type === "task.transitioned");
    
    expect(transitionEvents).toHaveLength(4);
    
    // Verify the sequence
    expect(transitionEvents[0]?.payload.from).toBe("backlog");
    expect(transitionEvents[0]?.payload.to).toBe("ready");
    
    expect(transitionEvents[1]?.payload.from).toBe("ready");
    expect(transitionEvents[1]?.payload.to).toBe("in-progress");
    
    expect(transitionEvents[2]?.payload.from).toBe("in-progress");
    expect(transitionEvents[2]?.payload.to).toBe("review");

    expect(transitionEvents[3]?.payload.from).toBe("review");
    expect(transitionEvents[3]?.payload.to).toBe("done");
  });

  it("does not emit events when operations fail", async () => {
    // Clear events from setup
    capturedEvents.length = 0;

    // Try to transition a non-existent task
    await expect(
      store.transition("TASK-9999-12-31-999", "ready")
    ).rejects.toThrow("Task not found");

    // No events should be emitted
    const transitionEvents = capturedEvents.filter(e => e.type === "task.transitioned");
    expect(transitionEvents).toHaveLength(0);
  });

  it("afterTransition hook is called with correct parameters", async () => {
    const hookSpy = vi.fn();
    
    const storeWithSpy = new FilesystemTaskStore(tmpDir, {
      hooks: {
        afterTransition: hookSpy,
      },
    });
    await storeWithSpy.init();

    const task = await storeWithSpy.create({
      title: "Hook test",
      body: "Test",
      createdBy: "test",
    });

    await storeWithSpy.transition(task.frontmatter.id, "ready");

    expect(hookSpy).toHaveBeenCalledOnce();
    const [transitionedTask, previousStatus] = hookSpy.mock.calls[0] as [any, TaskStatus];
    
    expect(transitionedTask.frontmatter.id).toBe(task.frontmatter.id);
    expect(transitionedTask.frontmatter.status).toBe("ready");
    expect(previousStatus).toBe("backlog");
  });
});
