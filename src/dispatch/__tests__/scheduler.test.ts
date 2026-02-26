import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import writeFileAtomic from "write-file-atomic";
import { FilesystemTaskStore, serializeTask } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { acquireLease } from "../../store/lease.js";
import { poll } from "../scheduler.js";
import { MockAdapter } from "../executor.js";

describe("Scheduler", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-sched-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const config = {
    dataDir: "",
    dryRun: true,
    defaultLeaseTtlMs: 600_000,
  };

  it("reports empty state with no actions", async () => {
    const result = await poll(store, logger, config);

    expect(result.stats.total).toBe(0);
    expect(result.actions).toHaveLength(0);
    expect(result.dryRun).toBe(true);
  });

  it("flags ready tasks with routing as assignable", async () => {
    const task = await store.create({
      title: "Routed task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await poll(store, logger, config);

    expect(result.stats.ready).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe("assign");
    expect(result.actions[0]!.agent).toBe("swe-backend");
  });

  it("alerts for ready tasks without routing", async () => {
    const task = await store.create({
      title: "Unrouted task",
      createdBy: "main",
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await poll(store, logger, config);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe("alert");
    expect(result.actions[0]!.reason).toContain("no routing target");
  });

  it("detects expired leases", async () => {
    const task = await store.create({ title: "Stale", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    await acquireLease(store, task.frontmatter.id, "swe-backend", { ttlMs: 1 });

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 10));

    const result = await poll(store, logger, config);

    const expireActions = result.actions.filter((a) => a.type === "expire_lease");
    expect(expireActions).toHaveLength(1);
    expect(expireActions[0]!.agent).toBe("swe-backend");
  });

  it("blocks parents with incomplete subtasks", async () => {
    const parent = await store.create({ title: "Parent", createdBy: "main" });
    const child = await store.create({
      title: "Child",
      createdBy: "main",
      parentId: parent.frontmatter.id,
    });

    await store.transition(parent.frontmatter.id, "ready");
    await store.transition(child.frontmatter.id, "ready");

    const result = await poll(store, logger, config);

    const blockActions = result.actions.filter((a) => a.type === "block");
    expect(blockActions.length).toBe(1);
    expect(blockActions[0]!.taskId).toBe(parent.frontmatter.id);
  });

  it("requeues blocked parents when subtasks complete", async () => {
    const parent = await store.create({ title: "Parent", createdBy: "main" });
    const child = await store.create({
      title: "Child",
      createdBy: "main",
      parentId: parent.frontmatter.id,
    });

    await store.transition(parent.frontmatter.id, "blocked");
    await store.transition(child.frontmatter.id, "ready");
    await store.transition(child.frontmatter.id, "in-progress");
    await store.transition(child.frontmatter.id, "review");
    await store.transition(child.frontmatter.id, "done");

    const result = await poll(store, logger, config);

    const requeueActions = result.actions.filter((a) => a.type === "requeue");
    expect(requeueActions.length).toBe(1);
    expect(requeueActions[0]!.taskId).toBe(parent.frontmatter.id);
  });

  it("completes within performance budget", async () => {
    // Create 20 tasks
    for (let i = 0; i < 20; i++) {
      await store.create({ title: `Task ${i}`, createdBy: "main" });
    }

    const result = await poll(store, logger, config);

    expect(result.stats.total).toBe(20);
    expect(result.durationMs).toBeLessThan(1000); // Must complete in <1s
  });

  it("writes event log on poll", async () => {
    await poll(store, logger, config);

    const { readFile } = await import("node:fs/promises");
    const { readdir } = await import("node:fs/promises");
    const eventsDir = join(tmpDir, "events");
    const files = await readdir(eventsDir);
    expect(files.length).toBeGreaterThan(0);

    const content = await readFile(join(eventsDir, files[0]!), "utf-8");
    const event = JSON.parse(content.trim());
    expect(event.type).toBe("scheduler.poll");
    expect(event.payload.dryRun).toBe(true);
  });

  it("spawns agents when executor is provided (active dispatch)", async () => {
    const executor = new MockAdapter();
    const activeConfig = {
      ...config,
      dryRun: false,
      executor,
    };

    const task = await store.create({
      title: "Active task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, activeConfig);

    expect(executor.spawned).toHaveLength(1);
    expect(executor.spawned[0]!.context.taskId).toBe(task.frontmatter.id);
    expect(executor.spawned[0]!.context.agent).toBe("swe-backend");

    // Task should now have a lease (in-progress)
    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.lease).toBeDefined();
    expect(updated?.frontmatter.lease?.agent).toBe("swe-backend");
  });

  it("renews leases while dispatched sessions are active", async () => {
    const executor = new MockAdapter();
    const activeConfig = {
      ...config,
      dryRun: false,
      executor,
      defaultLeaseTtlMs: 200,
    };

    const task = await store.create({
      title: "Lease renewal task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, activeConfig);

    let updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.lease?.renewCount).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 250));

    updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.lease?.renewCount).toBeGreaterThanOrEqual(1);

    await store.transition(task.frontmatter.id, "ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  it("moves task to blocked on spawn failure", async () => {
    const executor = new MockAdapter();
    executor.setShouldFail(true, "Agent unavailable");

    const activeConfig = {
      ...config,
      dryRun: false,
      executor,
    };

    const task = await store.create({
      title: "Failing task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, activeConfig);

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("blocked");
  });

  it("does not spawn without executor (dry-run mode)", async () => {
    const task = await store.create({
      title: "Dry-run task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task.frontmatter.id, "ready");

    await poll(store, logger, config); // No executor

    // Task should still be ready (not spawned)
    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("ready");
    expect(updated?.frontmatter.lease).toBeUndefined();
  });

  describe("TASK-056: Dispatch dedup", () => {
    it("skips ready tasks with active leases", async () => {
      const task = await store.create({
        title: "Leased task",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const readyTask = await store.get(task.frontmatter.id);
      expect(readyTask).toBeDefined();

      const now = new Date();
      if (readyTask) {
        readyTask.frontmatter.lease = {
          agent: "swe-backend",
          acquiredAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
          renewCount: 0,
        };
        readyTask.frontmatter.updatedAt = now.toISOString();
        await writeFileAtomic(readyTask.path!, serializeTask(readyTask));
      }

      const result = await poll(store, logger, config);
      const assignActions = result.actions.filter(action => action.type === "assign");
      expect(assignActions).toHaveLength(0);
      expect(result.stats.ready).toBe(1);
    });

    it("skips dispatch when task becomes in-progress before execution", async () => {
      const executor = new MockAdapter();
      const activeConfig = {
        ...config,
        dryRun: false,
        executor,
      };

      const task = await store.create({
        title: "Race task",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const originalGet = store.get.bind(store);
      const now = new Date();
      const lease = {
        agent: "swe-backend",
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        renewCount: 0,
      };

      const getSpy = vi.spyOn(store, "get").mockImplementation(async (id: string) => {
        const current = await originalGet(id);
        if (id === task.frontmatter.id && current) {
          return {
            ...current,
            frontmatter: {
              ...current.frontmatter,
              status: "in-progress",
              lease,
            },
          };
        }
        return current;
      });

      const result = await poll(store, logger, activeConfig);

      expect(result.actions.length).toBe(1);
      expect(result.actions[0]!.type).toBe("assign");
      expect(executor.spawned).toHaveLength(0);

      const updated = await originalGet(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("ready");

      getSpy.mockRestore();
    });
  });

  describe("BUG-005: Scheduler Validation Tests", () => {
    it("logs actionsPlanned > 0 when ready tasks with routing exist", async () => {
      const task = await store.create({
        title: "Test task for scheduler",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const result = await poll(store, logger, config);

      // Verify poll result shows planned actions
      expect(result.actions.length).toBeGreaterThan(0);
      expect(result.stats.ready).toBe(1);

      // Verify event log contains scheduler.poll event with correct metrics
      const { readdir, readFile } = await import("node:fs/promises");
      const eventsDir = join(tmpDir, "events");
      const files = await readdir(eventsDir);
      expect(files.length).toBeGreaterThan(0);

      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const pollEvent = events.find(e => e.type === "scheduler.poll");

      expect(pollEvent).toBeDefined();
      expect(pollEvent.payload.actionsPlanned).toBeGreaterThan(0);
      expect(pollEvent.payload.dryRun).toBe(true);
    });

    it("logs actionsExecuted > 0 in non-dryRun mode when actions are taken", async () => {
      const executor = new MockAdapter();
      const activeConfig = {
        ...config,
        dryRun: false,
        executor,
      };

      const task = await store.create({
        title: "Active mode task",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const result = await poll(store, logger, activeConfig);

      // Verify actions were planned and executed
      expect(result.actions.length).toBeGreaterThan(0);
      expect(result.dryRun).toBe(false);

      // Verify event log shows actionsExecuted > 0
      const { readdir, readFile } = await import("node:fs/promises");
      const eventsDir = join(tmpDir, "events");
      const files = await readdir(eventsDir);
      expect(files.length).toBeGreaterThan(0);

      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const pollEvent = events.find(e => e.type === "scheduler.poll");

      expect(pollEvent).toBeDefined();
      expect(pollEvent.payload.actionsPlanned).toBeGreaterThan(0);
      expect(pollEvent.payload.actionsExecuted).toBeGreaterThan(0);
      expect(pollEvent.payload.actionsExecuted).toBe(pollEvent.payload.actionsPlanned);
      expect(pollEvent.payload.dryRun).toBe(false);
    });

    it("logs actionsPlanned = 0 and actionsExecuted = 0 when no work exists", async () => {
      // Empty store - no tasks
      const result = await poll(store, logger, config);

      expect(result.actions.length).toBe(0);
      expect(result.stats.total).toBe(0);

      // Verify event log reflects empty queue
      const { readdir, readFile } = await import("node:fs/promises");
      const eventsDir = join(tmpDir, "events");
      const files = await readdir(eventsDir);
      expect(files.length).toBeGreaterThan(0);

      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const pollEvent = events.find(e => e.type === "scheduler.poll");

      expect(pollEvent).toBeDefined();
      expect(pollEvent.payload.actionsPlanned).toBe(0);
      expect(pollEvent.payload.actionsExecuted).toBe(0);
    });

    it("verifies end-to-end flow: task creation → scheduler poll → execution → state transition → event logging", async () => {
      const executor = new MockAdapter();
      const activeConfig = {
        ...config,
        dryRun: false,
        executor,
      };

      // 1. Create a task via TaskStore
      const task = await store.create({
        title: "E2E integration task",
        body: "Test scheduler picks this up and executes it",
        createdBy: "main",
        routing: { agent: "swe-qa" },
        priority: "normal",
      });

      // 2. Verify task starts in backlog
      expect(task.frontmatter.status).toBe("backlog");

      // 3. Transition to ready
      await store.transition(task.frontmatter.id, "ready");
      const readyTask = await store.get(task.frontmatter.id);
      expect(readyTask?.frontmatter.status).toBe("ready");

      // 4. Scheduler poll should pick it up
      const pollResult = await poll(store, logger, activeConfig);

      // 5. Verify scheduler planned and executed actions
      expect(pollResult.actions.length).toBeGreaterThan(0);
      const assignAction = pollResult.actions.find(a => 
        a.type === "assign" && a.taskId === task.frontmatter.id
      );
      expect(assignAction).toBeDefined();
      expect(assignAction?.agent).toBe("swe-qa");

      // 6. Verify task transitioned to in-progress with lease
      const executedTask = await store.get(task.frontmatter.id);
      expect(executedTask?.frontmatter.status).toBe("in-progress");
      expect(executedTask?.frontmatter.lease).toBeDefined();
      expect(executedTask?.frontmatter.lease?.agent).toBe("swe-qa");

      // 7. Verify executor received spawn request
      expect(executor.spawned.length).toBe(1);
      expect(executor.spawned[0]?.context.taskId).toBe(task.frontmatter.id);
      expect(executor.spawned[0]?.context.agent).toBe("swe-qa");
      expect(executor.spawned[0]?.context.taskPath).toBe(
        join(store.tasksDir, "in-progress", `${task.frontmatter.id}.md`),
      );

      // 8. Verify event log contains all expected events
      const { readdir, readFile } = await import("node:fs/promises");
      const eventsDir = join(tmpDir, "events");
      const files = await readdir(eventsDir);
      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));

      // Check for scheduler.poll event
      const pollEvent = events.find(e => e.type === "scheduler.poll");
      expect(pollEvent).toBeDefined();
      expect(pollEvent.payload.actionsPlanned).toBeGreaterThan(0);
      expect(pollEvent.payload.actionsExecuted).toBeGreaterThan(0);

      // Check for dispatch.matched event (indicates successful spawn)
      const dispatchEvent = events.find(e => 
        e.type === "dispatch.matched" && e.taskId === task.frontmatter.id
      );
      expect(dispatchEvent).toBeDefined();
      expect(dispatchEvent.payload.agent).toBe("swe-qa");
      expect(dispatchEvent.payload.sessionId).toBeDefined();
    });

    it("handles multiple ready tasks in single poll cycle", async () => {
      const executor = new MockAdapter();
      const activeConfig = {
        ...config,
        dryRun: false,
        executor,
      };

      // Create 3 ready tasks
      const task1 = await store.create({
        title: "Task 1",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task1.frontmatter.id, "ready");

      const task2 = await store.create({
        title: "Task 2",
        createdBy: "main",
        routing: { agent: "swe-frontend" },
      });
      await store.transition(task2.frontmatter.id, "ready");

      const task3 = await store.create({
        title: "Task 3",
        createdBy: "main",
        routing: { agent: "swe-qa" },
      });
      await store.transition(task3.frontmatter.id, "ready");

      // Single poll should handle all 3
      const pollResult = await poll(store, logger, activeConfig);

      // Stats reflect post-execution state (tasks transitioned to in-progress)
      expect(pollResult.stats.inProgress).toBe(3);
      expect(pollResult.stats.ready).toBe(0);
      expect(pollResult.actions.length).toBe(3);
      expect(executor.spawned.length).toBe(3);

      // Verify event log shows correct metrics
      const { readdir, readFile } = await import("node:fs/promises");
      const eventsDir = join(tmpDir, "events");
      const files = await readdir(eventsDir);
      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const pollEvent = events.find(e => e.type === "scheduler.poll");

      expect(pollEvent.payload.actionsPlanned).toBe(3);
      expect(pollEvent.payload.actionsExecuted).toBe(3);
    });

    it("correctly reports stats when tasks are in various states", async () => {
      // Create tasks in different states
      const backlogTask = await store.create({
        title: "Backlog task",
        createdBy: "main",
      });

      const readyTask = await store.create({
        title: "Ready task",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(readyTask.frontmatter.id, "ready");

      const blockedTask = await store.create({
        title: "Blocked task",
        createdBy: "main",
      });
      await store.transition(blockedTask.frontmatter.id, "blocked");

      const doneTask = await store.create({
        title: "Done task",
        createdBy: "main",
      });
      // Valid transition path: backlog → ready → in-progress → review → done
      await store.transition(doneTask.frontmatter.id, "ready");
      await store.transition(doneTask.frontmatter.id, "in-progress");
      await store.transition(doneTask.frontmatter.id, "review");
      await store.transition(doneTask.frontmatter.id, "done");

      const result = await poll(store, logger, config);

      expect(result.stats.total).toBe(4);
      expect(result.stats.backlog).toBe(1);
      expect(result.stats.ready).toBe(1);
      expect(result.stats.blocked).toBe(1);
      expect(result.stats.done).toBe(1);

      // Verify event log contains correct stats
      const { readdir, readFile } = await import("node:fs/promises");
      const eventsDir = join(tmpDir, "events");
      const files = await readdir(eventsDir);
      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const pollEvent = events.find(e => e.type === "scheduler.poll");

      expect(pollEvent.payload.stats).toEqual(result.stats);
    });
  });

  describe("BUG-003: Scheduler Task Progression", () => {
    it("does NOT count alert actions as executed (no state change)", async () => {
      // Task with no agent/role/team should generate alert, not execute
      const task = await store.create({
        title: "Task with tags only",
        createdBy: "main",
        routing: { tags: ["test", "qa"] }, // No agent/role/team!
      });
      await store.transition(task.frontmatter.id, "ready");

      const result = await poll(store, logger, config);

      // Should plan an alert action
      expect(result.actions.length).toBe(1);
      expect(result.actions[0]!.type).toBe("alert");

      // But should NOT count as executed (no actual work done)
      const { readFile, readdir } = await import("node:fs/promises");
      const eventsDir = join(tmpDir, "events");
      const files = await readdir(eventsDir);
      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const pollEvent = events.find(e => e.type === "scheduler.poll");

      expect(pollEvent.payload.actionsPlanned).toBe(1);
      expect(pollEvent.payload.actionsExecuted).toBe(0); // BUG: currently reports 0 in dryRun
    });

    it("logs warning when ready task has no eligible agent", async () => {
      const executor = new MockAdapter();
      const activeConfig = {
        ...config,
        dryRun: false,
        executor,
      };

      const task = await store.create({
        title: "Task with no routing target",
        createdBy: "main",
        routing: { tags: ["unrouted"] },
      });
      await store.transition(task.frontmatter.id, "ready");

      const result = await poll(store, logger, activeConfig);

      // Should create alert action
      const alertActions = result.actions.filter(a => a.type === "alert");
      expect(alertActions.length).toBe(1);
      expect(alertActions[0]!.reason).toContain("no routing target");

      // Task should still be in ready (no progression)
      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("ready");

      // Should NOT increment actionsExecuted (no real state change)
      const { readFile, readdir } = await import("node:fs/promises");
      const eventsDir = join(tmpDir, "events");
      const files = await readdir(eventsDir);
      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const pollEvent = events.find(e => e.type === "scheduler.poll");

      // BUG: Currently reports actionsExecuted = actionsPlanned even though nothing happened
      expect(pollEvent.payload.actionsExecuted).toBe(0);
    });

    it("transitions ready task to in-progress when executor succeeds", async () => {
      const executor = new MockAdapter();
      const activeConfig = {
        ...config,
        dryRun: false,
        executor,
      };

      const task = await store.create({
        title: "Task with valid routing",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const result = await poll(store, logger, activeConfig);

      // Should create assign action and execute it
      const assignActions = result.actions.filter(a => a.type === "assign");
      expect(assignActions.length).toBe(1);

      // Task should now be in-progress
      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("in-progress");
      expect(updated?.frontmatter.lease).toBeDefined();

      // Should count as executed (real state change occurred)
      const { readFile, readdir } = await import("node:fs/promises");
      const eventsDir = join(tmpDir, "events");
      const files = await readdir(eventsDir);
      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const pollEvent = events.find(e => e.type === "scheduler.poll");

      expect(pollEvent.payload.actionsExecuted).toBe(1);
    });
  });

  describe("concurrency controls (maxConcurrentDispatches)", () => {
    it("defaults to 3 concurrent dispatches when not configured", async () => {
      // Create 5 ready tasks
      for (let i = 1; i <= 5; i++) {
        const task = await store.create({
          title: `Task ${i}`,
          createdBy: "main",
          routing: { agent: "swe-backend" },
        });
        await store.transition(task.frontmatter.id, "ready");
      }

      const result = await poll(store, logger, config);

      // Should plan at most 3 assign actions (default cap)
      const assignActions = result.actions.filter(a => a.type === "assign");
      expect(assignActions.length).toBe(3);
    });

    it("respects custom maxConcurrentDispatches limit", async () => {
      const customConfig = {
        ...config,
        maxConcurrentDispatches: 2,
      };

      // Create 5 ready tasks
      for (let i = 1; i <= 5; i++) {
        const task = await store.create({
          title: `Task ${i}`,
          createdBy: "main",
          routing: { agent: "swe-backend" },
        });
        await store.transition(task.frontmatter.id, "ready");
      }

      const result = await poll(store, logger, customConfig);

      // Should plan at most 2 assign actions
      const assignActions = result.actions.filter(a => a.type === "assign");
      expect(assignActions.length).toBe(2);
    });

    it("skips assign when at capacity (in-progress tasks)", async () => {
      const customConfig = {
        ...config,
        maxConcurrentDispatches: 2,
      };

      // Create 2 in-progress tasks
      for (let i = 1; i <= 2; i++) {
        const task = await store.create({
          title: `In Progress ${i}`,
          createdBy: "main",
          routing: { agent: "swe-backend" },
        });
        await store.transition(task.frontmatter.id, "ready");
        await acquireLease(store, task.frontmatter.id, "swe-backend");
      }

      // Create 1 ready task
      const readyTask = await store.create({
        title: "Ready Task",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(readyTask.frontmatter.id, "ready");

      const result = await poll(store, logger, customConfig);

      // Should not plan any assign actions (already at capacity: 2/2)
      const assignActions = result.actions.filter(a => a.type === "assign");
      expect(assignActions.length).toBe(0);
      expect(result.stats.inProgress).toBe(2);
    });

    it("allows partial assignments when below capacity", async () => {
      const customConfig = {
        ...config,
        maxConcurrentDispatches: 3,
      };

      // Create 1 in-progress task
      const inProgressTask = await store.create({
        title: "In Progress",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(inProgressTask.frontmatter.id, "ready");
      await acquireLease(store, inProgressTask.frontmatter.id, "swe-backend");

      // Create 5 ready tasks
      for (let i = 1; i <= 5; i++) {
        const task = await store.create({
          title: `Ready ${i}`,
          createdBy: "main",
          routing: { agent: "swe-backend" },
        });
        await store.transition(task.frontmatter.id, "ready");
      }

      const result = await poll(store, logger, customConfig);

      // Should plan 2 assign actions (1 in-progress + 2 pending = 3 total)
      const assignActions = result.actions.filter(a => a.type === "assign");
      expect(assignActions.length).toBe(2);
      expect(result.stats.inProgress).toBe(1);
    });

    it("does not double-count pending assignments in same poll", async () => {
      const customConfig = {
        ...config,
        maxConcurrentDispatches: 5,
      };

      // Create 10 ready tasks
      for (let i = 1; i <= 10; i++) {
        const task = await store.create({
          title: `Task ${i}`,
          createdBy: "main",
          routing: { agent: "swe-backend" },
        });
        await store.transition(task.frontmatter.id, "ready");
      }

      const result = await poll(store, logger, customConfig);

      // Should plan exactly 5 assign actions (cap), not more
      const assignActions = result.actions.filter(a => a.type === "assign");
      expect(assignActions.length).toBe(5);
    });

    it("allows zero in-progress if all slots available", async () => {
      const customConfig = {
        ...config,
        maxConcurrentDispatches: 1,
      };

      // Create 1 ready task
      const task = await store.create({
        title: "Single Task",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const result = await poll(store, logger, customConfig);

      // Should plan 1 assign action
      const assignActions = result.actions.filter(a => a.type === "assign");
      expect(assignActions.length).toBe(1);
      expect(result.stats.inProgress).toBe(0);
    });
  });
});
