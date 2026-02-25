import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import type { DispatchExecutor, ExecutorResult, TaskContext } from "../executor.js";

describe("Scheduler - Adaptive Concurrency", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-scheduler-adaptive-"));
    store = new FilesystemTaskStore(tmpDir, { projectId: "test-project" });
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should detect platform limit and adjust effective cap", async () => {
    // Create tasks
    await store.create({
      createdBy: "test",
      title: "Task 1",
      description: "Test task 1",
      priority: "normal",
      routing: { agent: "agent:test:main" },
    });
    await store.create({
      createdBy: "test",
      title: "Task 2",
      description: "Test task 2",
      priority: "normal",
      routing: { agent: "agent:test:main" },
    });

    // Move tasks to ready
    const tasks = await store.list();
    await store.transition(tasks[0].frontmatter.id, "ready");
    await store.transition(tasks[1].frontmatter.id, "ready");

    // Mock executor that returns platform limit error
    let callCount = 0;
    const mockExecutor: DispatchExecutor = {
      async spawn(_context: TaskContext): Promise<ExecutorResult> {
        callCount++;
        return {
          success: false,
          error: "sessions_spawn has reached max active children for this session (1/1)",
          platformLimit: 1, // Platform limit is 1
        };
      },
    };

    // First poll should detect platform limit and adjust cap
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3, // We want 3, but platform only allows 1
    });

    // Should have attempted to dispatch both tasks (hits limit on each)
    expect(callCount).toBeGreaterThanOrEqual(1);
    
    // Task should be requeued to ready (not blocked)
    const updatedTasks = await store.list();
    const task1 = updatedTasks.find(t => t.frontmatter.id === tasks[0].frontmatter.id);
    expect(task1?.frontmatter.status).toBe("ready");
    
    // Task should NOT have retry count incremented
    expect(task1?.frontmatter.metadata?.retryCount).toBeUndefined();

    // Check events for platform limit detection
    const events = await logger.query();
    const platformLimitEvent = events.find(e => e.type === "concurrency.platformLimit");
    expect(platformLimitEvent).toBeDefined();
    expect(platformLimitEvent?.payload?.detectedLimit).toBe(1);
    expect(platformLimitEvent?.payload?.effectiveCap).toBe(1);
    expect(platformLimitEvent?.payload?.previousCap).toBe(3);
  });

  it("should respect effective cap in action planning", async () => {
    // Create 3 tasks
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

    let callCount = 0;
    const mockExecutor: DispatchExecutor = {
      async spawn(_context: TaskContext): Promise<ExecutorResult> {
        callCount++;
        // First call: platform limit error
        if (callCount === 1) {
          return {
            success: false,
            error: "sessions_spawn has reached max active children for this session (1/1)",
            platformLimit: 1,
          };
        }
        // Should not be called again in the same poll
        throw new Error("Should not attempt more dispatches after detecting limit");
      },
    };

    // Poll with max 3 configured, but platform allows only 1
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3,
    });

    // Should only attempt one dispatch (respects platform limit of 1)
    expect(callCount).toBe(1);
  });

  it("should use min(platform, config) for effective cap", async () => {
    // Create task
    const task = await store.create({
      createdBy: "test",
      title: "Test Task",
      description: "Test task",
      priority: "normal",
      routing: { agent: "agent:test:main" },
    });
    await store.transition(task.frontmatter.id, "ready");

    const mockExecutor: DispatchExecutor = {
      async spawn(_context: TaskContext): Promise<ExecutorResult> {
        return {
          success: false,
          error: "sessions_spawn has reached max active children for this session (5/5)",
          platformLimit: 5, // Platform allows 5
        };
      },
    };

    // Config allows only 2, platform allows 5
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: mockExecutor,
      maxConcurrentDispatches: 2, // Config limit is lower
    });

    // Check that effective cap is min(5, 2) = 2
    const events = await logger.query();
    const platformLimitEvent = events.find(e => e.type === "concurrency.platformLimit");
    expect(platformLimitEvent?.payload?.effectiveCap).toBe(2);
  });

  it("should not increment retry count for platform limit errors", async () => {
    const task = await store.create({
      createdBy: "test",
      title: "Test Task",
      description: "Test task",
      priority: "normal",
      routing: { agent: "agent:test:main" },
    });
    await store.transition(task.frontmatter.id, "ready");

    const mockExecutor: DispatchExecutor = {
      async spawn(_context: TaskContext): Promise<ExecutorResult> {
        return {
          success: false,
          error: "sessions_spawn has reached max active children for this session (1/1)",
          platformLimit: 1,
        };
      },
    };

    // Poll multiple times
    for (let i = 0; i < 3; i++) {
      await poll(store, logger, {
        dataDir: tmpDir,
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        executor: mockExecutor,
        maxConcurrentDispatches: 3,
      });
    }

    // Task should still have no retry count
    const tasks = await store.list();
    const updatedTask = tasks.find(t => t.frontmatter.id === task.frontmatter.id);
    expect(updatedTask?.frontmatter.metadata?.retryCount).toBeUndefined();
  });

  it("should requeue to ready, not blocked, on platform limit", async () => {
    const task = await store.create({
      createdBy: "test",
      title: "Test Task",
      description: "Test task",
      priority: "normal",
      routing: { agent: "agent:test:main" },
    });
    await store.transition(task.frontmatter.id, "ready");

    const mockExecutor: DispatchExecutor = {
      async spawn(_context: TaskContext): Promise<ExecutorResult> {
        return {
          success: false,
          error: "sessions_spawn has reached max active children for this session (1/1)",
          platformLimit: 1,
        };
      },
    };

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3,
    });

    // Task should be in ready, not blocked
    const tasks = await store.list();
    const updatedTask = tasks.find(t => t.frontmatter.id === task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("ready");
  });

  it("should deadletter permanent errors and block transient errors", async () => {
    // Permanent error: "Agent not found" → deadletter immediately
    const permTask = await store.create({
      createdBy: "test",
      title: "Permanent Error Task",
      description: "Test task",
      priority: "normal",
      routing: { agent: "agent:test:main" },
    });
    await store.transition(permTask.frontmatter.id, "ready");

    const permExecutor: DispatchExecutor = {
      async spawn(_context: TaskContext): Promise<ExecutorResult> {
        return {
          success: false,
          error: "Agent not found",
        };
      },
    };

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: permExecutor,
      maxConcurrentDispatches: 3,
    });

    const permTasks = await store.list();
    const updatedPermTask = permTasks.find(t => t.frontmatter.id === permTask.frontmatter.id);
    expect(updatedPermTask?.frontmatter.status).toBe("deadletter");

    // Transient error: "gateway timeout" → blocked with retry
    const transTask = await store.create({
      createdBy: "test",
      title: "Transient Error Task",
      description: "Test task",
      priority: "normal",
      routing: { agent: "agent:test:main" },
    });
    await store.transition(transTask.frontmatter.id, "ready");

    const transExecutor: DispatchExecutor = {
      async spawn(_context: TaskContext): Promise<ExecutorResult> {
        return {
          success: false,
          error: "gateway timeout",
        };
      },
    };

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor: transExecutor,
      maxConcurrentDispatches: 3,
    });

    const transTasks = await store.list();
    const updatedTransTask = transTasks.find(t => t.frontmatter.id === transTask.frontmatter.id);
    expect(updatedTransTask?.frontmatter.status).toBe("blocked");
    expect(updatedTransTask?.frontmatter.metadata?.retryCount).toBe(1);
  });
});
