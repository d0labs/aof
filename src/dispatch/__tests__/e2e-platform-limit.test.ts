import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import type { DispatchExecutor, ExecutorResult, TaskContext } from "../executor.js";

describe("E2E - Platform Limit Detection", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-e2e-platform-"));
    store = new FilesystemTaskStore(tmpDir, { projectId: "test-project" });
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should detect platform limit, requeue tasks, and respect cap on next poll", async () => {
    // Create 3 tasks, but platform only allows 1
    const taskIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        createdBy: "test",
        title: `Task ${i + 1}`,
        description: `Test task ${i + 1}`,
        priority: "normal",
        routing: { agent: "agent:test:main" },
      });
      taskIds.push(task.frontmatter.id);
      await store.transition(task.frontmatter.id, "ready");
    }

    let activeDispatches = 0;
    const dispatched: string[] = [];
    
    const mockExecutor: DispatchExecutor = {
      async spawn(context: TaskContext): Promise<ExecutorResult> {
        // Platform allows only 1 active dispatch
        if (activeDispatches >= 1) {
          return {
            success: false,
            error: "sessions_spawn has reached max active children for this session (1/1)",
            platformLimit: 1,
          };
        }
        
        // Success - mark as active
        activeDispatches++;
        dispatched.push(context.taskId);
        return {
          success: true,
          sessionId: `session-${context.taskId}`,
        };
      },
    };

    // First poll: should dispatch 1 task successfully, hit limit on second
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3, // We want 3, but platform allows 1
    });

    // Should have dispatched 1 task
    expect(dispatched.length).toBe(1);
    
    // Check task states
    let tasks = await store.list();
    const inProgress = tasks.filter(t => t.frontmatter.status === "in-progress");
    const ready = tasks.filter(t => t.frontmatter.status === "ready");
    
    expect(inProgress.length).toBe(1); // One dispatched
    expect(ready.length).toBe(2); // Two still ready (not blocked)

    // Complete the in-progress task to free a slot
    await store.transition(inProgress[0].frontmatter.id, "review");
    await store.transition(inProgress[0].frontmatter.id, "done");
    activeDispatches = 0; // Free the slot

    // Second poll: should dispatch one more task (respects limit of 1)
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3,
    });

    // Should have dispatched one more task
    expect(dispatched.length).toBe(2);
    
    // Check final states
    tasks = await store.list();
    expect(tasks.filter(t => t.frontmatter.status === "in-progress").length).toBe(1);
    expect(tasks.filter(t => t.frontmatter.status === "ready").length).toBe(1);
    expect(tasks.filter(t => t.frontmatter.status === "done").length).toBe(1);
  });

  it("should eventually dispatch all tasks as slots open", async () => {
    // Create 5 tasks
    const taskIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const task = await store.create({
        createdBy: "test",
        title: `Task ${i + 1}`,
        description: `Test task ${i + 1}`,
        priority: "normal",
        routing: { agent: "agent:test:main" },
      });
      taskIds.push(task.frontmatter.id);
      await store.transition(task.frontmatter.id, "ready");
    }

    const activeDispatches = new Set<string>();
    const completed: string[] = [];
    const PLATFORM_LIMIT = 2; // Platform allows 2 concurrent dispatches
    
    const mockExecutor: DispatchExecutor = {
      async spawn(context: TaskContext): Promise<ExecutorResult> {
        // Platform allows only 2 active dispatches
        if (activeDispatches.size >= PLATFORM_LIMIT) {
          return {
            success: false,
            error: `sessions_spawn has reached max active children for this session (${activeDispatches.size}/${PLATFORM_LIMIT})`,
            platformLimit: PLATFORM_LIMIT,
          };
        }
        
        // Success - mark as active
        activeDispatches.add(context.taskId);
        return {
          success: true,
          sessionId: `session-${context.taskId}`,
        };
      },
    };

    // Poll until all tasks are done
    let pollCount = 0;
    const MAX_POLLS = 20;
    
    while (pollCount < MAX_POLLS) {
      pollCount++;
      
      // Poll for new tasks
      await poll(store, logger, {
        dataDir: tmpDir,
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        executor: mockExecutor,
        maxConcurrentDispatches: 5, // Want 5, but platform limits to 2
      });

      // Simulate some tasks completing
      const tasks = await store.list();
      const inProgress = tasks.filter(t => t.frontmatter.status === "in-progress");
      
      // Complete one task per poll to simulate gradual progress
      if (inProgress.length > 0 && Math.random() > 0.3) {
        const taskToComplete = inProgress[0];
        await store.transition(taskToComplete.frontmatter.id, "review");
        await store.transition(taskToComplete.frontmatter.id, "done");
        activeDispatches.delete(taskToComplete.frontmatter.id);
        completed.push(taskToComplete.frontmatter.id);
      }

      // Check if all tasks are done
      const allTasks = await store.list();
      if (allTasks.every(t => t.frontmatter.status === "done")) {
        break;
      }
    }

    // All tasks should eventually complete
    const finalTasks = await store.list();
    expect(finalTasks.filter(t => t.frontmatter.status === "done").length).toBe(5);
    
    // Should have taken multiple polls due to concurrency limit
    expect(pollCount).toBeGreaterThan(1);
    
    // All tasks should have been dispatched at least once
    // (Even if some completed quickly, we should have attempted all 5)
    expect(pollCount).toBeLessThan(MAX_POLLS); // Didn't timeout
  });
});
