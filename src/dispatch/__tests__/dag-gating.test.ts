import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";

describe("DAG Dependency Gating", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-dag-test-"));
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

  it("dispatches task with no dependsOn normally", async () => {
    const task = await store.create({
      title: "Independent task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await poll(store, logger, config);

    expect(result.stats.ready).toBe(1);
    const assignActions = result.actions.filter((a) => a.type === "assign");
    expect(assignActions).toHaveLength(1);
    expect(assignActions[0]!.taskId).toBe(task.frontmatter.id);
  });

  it("dispatches task with all deps in done normally", async () => {
    const dep1 = await store.create({
      title: "Dependency 1",
      createdBy: "main",
    });
    const dep2 = await store.create({
      title: "Dependency 2",
      createdBy: "main",
    });
    
    // Move dependencies to done
    await store.transition(dep1.frontmatter.id, "ready");
    await store.transition(dep1.frontmatter.id, "in-progress");
    await store.transition(dep1.frontmatter.id, "review");
    await store.transition(dep1.frontmatter.id, "done");
    
    await store.transition(dep2.frontmatter.id, "ready");
    await store.transition(dep2.frontmatter.id, "in-progress");
    await store.transition(dep2.frontmatter.id, "review");
    await store.transition(dep2.frontmatter.id, "done");

    const task = await store.create({
      title: "Dependent task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
      dependsOn: [dep1.frontmatter.id, dep2.frontmatter.id],
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await poll(store, logger, config);

    const assignActions = result.actions.filter((a) => a.type === "assign");
    expect(assignActions).toHaveLength(1);
    expect(assignActions[0]!.taskId).toBe(task.frontmatter.id);
  });

  it("blocks task with one unresolved dep", async () => {
    const dep = await store.create({
      title: "Unfinished dependency",
      createdBy: "main",
    });
    await store.transition(dep.frontmatter.id, "ready");

    const task = await store.create({
      title: "Dependent task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
      dependsOn: [dep.frontmatter.id],
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await poll(store, logger, config);

    // Should not dispatch the dependent task
    const assignActions = result.actions.filter((a) => a.type === "assign");
    const dependentAssign = assignActions.find((a) => a.taskId === task.frontmatter.id);
    expect(dependentAssign).toBeUndefined();
  });

  it("blocks task with multiple deps when some are not done", async () => {
    const dep1 = await store.create({
      title: "Dependency 1 (done)",
      createdBy: "main",
    });
    const dep2 = await store.create({
      title: "Dependency 2 (not done)",
      createdBy: "main",
    });
    
    // Move dep1 to done
    await store.transition(dep1.frontmatter.id, "ready");
    await store.transition(dep1.frontmatter.id, "in-progress");
    await store.transition(dep1.frontmatter.id, "review");
    await store.transition(dep1.frontmatter.id, "done");
    
    // Leave dep2 in ready
    await store.transition(dep2.frontmatter.id, "ready");

    const task = await store.create({
      title: "Dependent task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
      dependsOn: [dep1.frontmatter.id, dep2.frontmatter.id],
    });
    await store.transition(task.frontmatter.id, "ready");

    const result = await poll(store, logger, config);

    // Should not dispatch the dependent task
    const assignActions = result.actions.filter((a) => a.type === "assign");
    const dependentAssign = assignActions.find((a) => a.taskId === task.frontmatter.id);
    expect(dependentAssign).toBeUndefined();
  });

  it("logs which deps are blocking", async () => {
    const dep1 = await store.create({
      title: "Dependency 1",
      createdBy: "main",
    });
    const dep2 = await store.create({
      title: "Dependency 2",
      createdBy: "main",
    });
    
    await store.transition(dep1.frontmatter.id, "ready");
    await store.transition(dep2.frontmatter.id, "ready");
    await store.transition(dep2.frontmatter.id, "in-progress");

    const task = await store.create({
      title: "Dependent task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
      dependsOn: [dep1.frontmatter.id, dep2.frontmatter.id],
    });
    await store.transition(task.frontmatter.id, "ready");

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await poll(store, logger, config);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[AOF] Dependency gate: skipping ${task.frontmatter.id}`),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(dep1.frontmatter.id),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(dep2.frontmatter.id),
    );

    consoleSpy.mockRestore();
  });

  it("supports transitive dependencies (A→B→C)", async () => {
    // Create chain: taskA depends on taskB, taskB depends on taskC
    const taskC = await store.create({
      title: "Task C (base)",
      createdBy: "main",
    });
    await store.transition(taskC.frontmatter.id, "ready");

    const taskB = await store.create({
      title: "Task B (middle)",
      createdBy: "main",
      routing: { agent: "swe-backend" },
      dependsOn: [taskC.frontmatter.id],
    });
    await store.transition(taskB.frontmatter.id, "ready");

    const taskA = await store.create({
      title: "Task A (top)",
      createdBy: "main",
      routing: { agent: "swe-backend" },
      dependsOn: [taskB.frontmatter.id],
    });
    await store.transition(taskA.frontmatter.id, "ready");

    // First poll: taskC can be assigned (if it had routing), taskB and taskA blocked
    let result = await poll(store, logger, config);
    let assignActions = result.actions.filter((a) => a.type === "assign");
    expect(assignActions.find((a) => a.taskId === taskB.frontmatter.id)).toBeUndefined();
    expect(assignActions.find((a) => a.taskId === taskA.frontmatter.id)).toBeUndefined();

    // Move taskC to done
    await store.transition(taskC.frontmatter.id, "in-progress");
    await store.transition(taskC.frontmatter.id, "review");
    await store.transition(taskC.frontmatter.id, "done");

    // Second poll: taskB can be assigned, taskA still blocked
    result = await poll(store, logger, config);
    assignActions = result.actions.filter((a) => a.type === "assign");
    expect(assignActions.find((a) => a.taskId === taskB.frontmatter.id)).toBeDefined();
    expect(assignActions.find((a) => a.taskId === taskA.frontmatter.id)).toBeUndefined();

    // Move taskB to done
    await store.transition(taskB.frontmatter.id, "in-progress");
    await store.transition(taskB.frontmatter.id, "review");
    await store.transition(taskB.frontmatter.id, "done");

    // Third poll: taskA can now be assigned
    result = await poll(store, logger, config);
    assignActions = result.actions.filter((a) => a.type === "assign");
    expect(assignActions.find((a) => a.taskId === taskA.frontmatter.id)).toBeDefined();
  });

  it("detects circular dependencies and moves task to blocked", async () => {
    // Create circular dependency: taskA → taskB → taskA
    const taskA = await store.create({
      title: "Task A",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    
    const taskB = await store.create({
      title: "Task B",
      createdBy: "main",
      routing: { agent: "swe-backend" },
      dependsOn: [taskA.frontmatter.id],
    });

    // Update taskA to depend on taskB (creating the cycle)
    const taskAData = await store.get(taskA.frontmatter.id);
    taskAData.frontmatter.dependsOn = [taskB.frontmatter.id];
    const { serializeTask } = await import("../../store/task-store.js");
    const { writeFile } = await import("node:fs/promises");
    const serialized = serializeTask(taskAData);
    await writeFile(taskAData.path!, serialized);

    await store.transition(taskA.frontmatter.id, "ready");
    await store.transition(taskB.frontmatter.id, "ready");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await poll(store, logger, config);

    // Should detect circular dependency and log error
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[AOF] Circular dependency detected"),
    );

    // Should create block action for at least one of the tasks
    const blockActions = result.actions.filter((a) => a.type === "block");
    expect(blockActions.length).toBeGreaterThanOrEqual(1);

    consoleSpy.mockRestore();
  });

  it("handles mixed scenario: some tasks with deps, some without", async () => {
    // Create independent task
    const independent = await store.create({
      title: "Independent task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(independent.frontmatter.id, "ready");

    // Create dependency
    const dep = await store.create({
      title: "Dependency",
      createdBy: "main",
    });
    await store.transition(dep.frontmatter.id, "ready");

    // Create dependent task (blocked)
    const dependent = await store.create({
      title: "Dependent task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
      dependsOn: [dep.frontmatter.id],
    });
    await store.transition(dependent.frontmatter.id, "ready");

    const result = await poll(store, logger, config);

    // Independent task should be assignable
    const assignActions = result.actions.filter((a) => a.type === "assign");
    expect(assignActions.find((a) => a.taskId === independent.frontmatter.id)).toBeDefined();
    
    // Dependent task should NOT be assignable
    expect(assignActions.find((a) => a.taskId === dependent.frontmatter.id)).toBeUndefined();
  });

  it("handles non-existent dependency gracefully", async () => {
    const task = await store.create({
      title: "Task with missing dep",
      createdBy: "main",
      routing: { agent: "swe-backend" },
      dependsOn: ["TASK-9999-99-99-999"],
    });
    await store.transition(task.frontmatter.id, "ready");

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await poll(store, logger, config);

    // Should log warning about missing dependency
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[AOF] Dependency gate: skipping"),
    );

    // Should not dispatch the task
    const assignActions = result.actions.filter((a) => a.type === "assign");
    expect(assignActions.find((a) => a.taskId === task.frontmatter.id)).toBeUndefined();

    consoleSpy.mockRestore();
  });
});
