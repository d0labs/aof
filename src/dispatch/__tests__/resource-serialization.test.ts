/**
 * Resource Serialization Tests (TASK-054)
 *
 * Test resource-level serialization: only one task per resource can be in-progress at a time.
 * Prevents corruption from concurrent sessions writing to same workspace.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { FilesystemTaskStore, serializeTask } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import type { SchedulerConfig } from "../scheduler.js";
import type { Task } from "../../schemas/task.js";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";

describe("Resource Serialization (TASK-054)", () => {
  let testDataDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let config: SchedulerConfig;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Create temp test directory
    testDataDir = await mkdtemp(join(tmpdir(), "aof-resource-test-"));
    
    store = new FilesystemTaskStore(testDataDir);
    await store.init();
    
    const eventsDir = join(testDataDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
    
    config = {
      dataDir: testDataDir,
      dryRun: false,
      defaultLeaseTtlMs: 300_000, // 5min
      executor: {
        spawn: vi.fn().mockResolvedValue({ success: true, sessionId: "test-session" }),
      },
    };

    // Spy on console.warn to verify warning messages
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleWarnSpy.mockRestore();
    await rm(testDataDir, { recursive: true, force: true });
  });

  /**
   * Helper: Create a task with resource field (store.create doesn't support resource yet)
   */
  async function createTaskWithResource(task: Task): Promise<void> {
    const taskPath = join(testDataDir, "tasks", task.frontmatter.status, `${task.frontmatter.id}.md`);
    await writeFileAtomic(taskPath, serializeTask(task));
  }

  /**
   * Test 1: Two tasks with different resources can both dispatch in same poll
   */
  it("should dispatch tasks with different resources concurrently", async () => {
    // Create two ready tasks with different resources
    const task1: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-001",
        project: "AOF",
        title: "Task on resource A",
        status: "ready",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Test task on resource A",
    };

    const task2: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-002",
        project: "AOF",
        title: "Task on resource B",
        status: "ready",
        priority: "normal",
        routing: { agent: "swe-frontend", tags: [] },
        resource: "project-web",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Test task on resource B",
    };

    await createTaskWithResource(task1);
    await createTaskWithResource(task2);

    // Run poll
    const result = await poll(store, logger, config);

    // Both tasks should be dispatched (different resources)
    expect(result.actions.filter(a => a.type === "assign")).toHaveLength(2);
    expect(result.actions.some(a => a.taskId === "TASK-2026-02-09-001")).toBe(true);
    expect(result.actions.some(a => a.taskId === "TASK-2026-02-09-002")).toBe(true);

    // Verify both are now in-progress
    const updatedTask1 = await store.get("TASK-2026-02-09-001");
    const updatedTask2 = await store.get("TASK-2026-02-09-002");
    expect(updatedTask1?.frontmatter.status).toBe("in-progress");
    expect(updatedTask2?.frontmatter.status).toBe("in-progress");
  });

  /**
   * Test 2: Second task with same resource is blocked when first is in-progress
   */
  it("should block second task when same resource is occupied", async () => {
    // Create first task in-progress with resource
    const task1: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-003",
        project: "AOF",
        title: "Task occupying resource",
        status: "in-progress",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        lease: {
          agent: "swe-backend",
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          renewCount: 0,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Task occupying resource",
    };

    // Create second task ready with same resource
    const task2: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-004",
        project: "AOF",
        title: "Task waiting for resource",
        status: "ready",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Task waiting for resource",
    };

    await createTaskWithResource(task1);
    await createTaskWithResource(task2);

    // Run poll
    const result = await poll(store, logger, config);

    // Only task2 should NOT be dispatched (resource occupied)
    const assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions.some(a => a.taskId === "TASK-2026-02-09-004")).toBe(false);

    // Task2 should still be ready (not dispatched)
    const updatedTask2 = await store.get("TASK-2026-02-09-004");
    expect(updatedTask2?.frontmatter.status).toBe("ready");
  });

  /**
   * Test 3: Warning logged when task skipped due to resource conflict
   */
  it("should log warning with correct format when resource is occupied", async () => {
    // Create first task in-progress with resource
    const task1: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-005",
        project: "AOF",
        title: "Occupying task",
        status: "in-progress",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        lease: {
          agent: "swe-backend",
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          renewCount: 0,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Occupying task",
    };

    // Create second task ready with same resource
    const task2: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-006",
        project: "AOF",
        title: "Blocked task",
        status: "ready",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Blocked task",
    };

    await createTaskWithResource(task1);
    await createTaskWithResource(task2);

    // Run poll
    await poll(store, logger, config);

    // Verify warning was logged with correct format
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[AOF] Resource lock: skipping TASK-2026-02-09-006 (resource "project-aof" occupied by TASK-2026-02-09-005)')
    );
  });

  /**
   * Test 4: Tasks without resource field dispatch freely regardless of locks
   */
  it("should dispatch tasks without resource field regardless of locks", async () => {
    // Create task with resource (in-progress)
    const task1: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-007",
        project: "AOF",
        title: "Task with resource",
        status: "in-progress",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        lease: {
          agent: "swe-backend",
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          renewCount: 0,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Task with resource",
    };

    // Create task WITHOUT resource (ready) - should dispatch freely
    const task2: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-008",
        project: "AOF",
        title: "Task without resource",
        status: "ready",
        priority: "normal",
        routing: { agent: "swe-qa", tags: [] },
        // No resource field - unconstrained
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Task without resource",
    };

    await createTaskWithResource(task1);
    await createTaskWithResource(task2);

    // Run poll
    const result = await poll(store, logger, config);

    // Task2 should be dispatched (no resource constraint)
    const assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions.some(a => a.taskId === "TASK-2026-02-09-008")).toBe(true);

    // Verify it's now in-progress
    const updatedTask2 = await store.get("TASK-2026-02-09-008");
    expect(updatedTask2?.frontmatter.status).toBe("in-progress");
  });

  /**
   * Test 5: Resource is released when in-progress task completes (moves to done)
   */
  it("should release resource when task completes", async () => {
    // Create first task in-progress with resource
    const task1: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-009",
        project: "AOF",
        title: "Task completing",
        status: "in-progress",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        lease: {
          agent: "swe-backend",
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          renewCount: 0,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Task completing",
    };

    // Create second task ready with same resource
    const task2: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-010",
        project: "AOF",
        title: "Task waiting",
        status: "ready",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Task waiting",
    };

    await createTaskWithResource(task1);
    await createTaskWithResource(task2);

    // First poll - task2 should be blocked by resource
    let result = await poll(store, logger, config);
    let assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions.some(a => a.taskId === "TASK-2026-02-09-010")).toBe(false);

    // Complete task1 (transition to review then done)
    await store.transition("TASK-2026-02-09-009", "review");
    await store.transition("TASK-2026-02-09-009", "done");

    // Second poll - task2 should now be dispatched (resource freed)
    result = await poll(store, logger, config);
    assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions.some(a => a.taskId === "TASK-2026-02-09-010")).toBe(true);

    // Verify task2 is now in-progress
    const updatedTask2 = await store.get("TASK-2026-02-09-010");
    expect(updatedTask2?.frontmatter.status).toBe("in-progress");
  });

  /**
   * Test 6 (Bonus): Mixed scenario - one task with resource, one without
   */
  it("should handle mixed scenario: task with resource blocked, task without dispatched", async () => {
    // Create task in-progress with resource
    const task1: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-011",
        project: "AOF",
        title: "Occupying resource",
        status: "in-progress",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        lease: {
          agent: "swe-backend",
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          renewCount: 0,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Occupying resource",
    };

    // Create task ready with same resource (should be blocked)
    const task2: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-012",
        project: "AOF",
        title: "Blocked by resource",
        status: "ready",
        priority: "normal",
        routing: { agent: "swe-backend", tags: [] },
        resource: "project-aof",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Blocked by resource",
    };

    // Create task ready without resource (should dispatch)
    const task3: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-09-013",
        project: "AOF",
        title: "Unconstrained task",
        status: "ready",
        priority: "normal",
        routing: { agent: "swe-qa", tags: [] },
        // No resource field
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastTransitionAt: new Date().toISOString(),
        createdBy: "test",
        dependsOn: [],
        metadata: {},
      },
      body: "Unconstrained task",
    };

    await createTaskWithResource(task1);
    await createTaskWithResource(task2);
    await createTaskWithResource(task3);

    // Run poll
    const result = await poll(store, logger, config);
    const assignActions = result.actions.filter(a => a.type === "assign");

    // Task2 should NOT be dispatched (resource conflict)
    expect(assignActions.some(a => a.taskId === "TASK-2026-02-09-012")).toBe(false);

    // Task3 should be dispatched (no resource constraint)
    expect(assignActions.some(a => a.taskId === "TASK-2026-02-09-013")).toBe(true);

    // Verify states
    const updatedTask2 = await store.get("TASK-2026-02-09-012");
    const updatedTask3 = await store.get("TASK-2026-02-09-013");
    expect(updatedTask2?.frontmatter.status).toBe("ready");
    expect(updatedTask3?.frontmatter.status).toBe("in-progress");
  });
});
