import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Promotion Integration", () => {
  let testDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "aof-promotion-test-"));
    store = new FilesystemTaskStore(testDir, { projectId: "_inbox" });
    await store.init();
    logger = new EventLogger(join(testDir, "events"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("should auto-promote task when dependencies are done", async () => {
    // Create dependency
    const dep = await store.create({
      title: "Dependency task",
      priority: "normal",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    
    // Create main task depending on it
    const main = await store.create({
      title: "Main task",
      priority: "normal",
      dependsOn: [dep.frontmatter.id],
      routing: { agent: "test-agent" },
      createdBy: "test",
    });

    // Run scheduler - main should stay in backlog
    await poll(store, logger, {
      dataDir: testDir,
      dryRun: false,
      defaultLeaseTtlMs: 600000,
    });
    
    let updated = await store.get(main.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("backlog");

    // Complete dependency (ready → in-progress → review → done)
    await store.transition(dep.frontmatter.id, "in-progress", {
      agent: "test",
      reason: "test start",
    });
    await store.transition(dep.frontmatter.id, "review", {
      agent: "test",
      reason: "test review",
    });
    await store.transition(dep.frontmatter.id, "done", {
      agent: "test",
      reason: "test completion",
    });

    // Run scheduler - main should promote to ready
    const result = await poll(store, logger, {
      dataDir: testDir,
      dryRun: false,
      defaultLeaseTtlMs: 600000,
    });
    
    updated = await store.get(main.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("ready");
    
    // Check that promote action was logged
    const promoteAction = result.actions.find(a => 
      a.type === "promote" && a.taskId === main.frontmatter.id
    );
    expect(promoteAction).toBeDefined();
  });

  it("should not promote task when dependencies are incomplete", async () => {
    // Create dependency
    const dep = await store.create({
      title: "Dependency task",
      priority: "normal",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    
    // Create main task depending on it
    const main = await store.create({
      title: "Main task",
      priority: "normal",
      dependsOn: [dep.frontmatter.id],
      routing: { agent: "test-agent" },
      createdBy: "test",
    });

    // Run scheduler - main should stay in backlog (dep not done)
    const result = await poll(store, logger, {
      dataDir: testDir,
      dryRun: false,
      defaultLeaseTtlMs: 600000,
    });
    
    const updated = await store.get(main.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("backlog");
    
    // No promote action should exist
    const promoteAction = result.actions.find(a => 
      a.type === "promote" && a.taskId === main.frontmatter.id
    );
    expect(promoteAction).toBeUndefined();
  });

  it("should auto-promote task when all subtasks are done", async () => {
    // Create parent task
    const parent = await store.create({
      title: "Parent task",
      priority: "normal",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    
    // Create subtask
    const child = await store.create({
      title: "Child task",
      priority: "normal",
      routing: { agent: "test-agent" },
      createdBy: "test",
      parentId: parent.frontmatter.id,
    });

    // Run scheduler - parent should be moved to blocked (has incomplete subtasks)
    await poll(store, logger, {
      dataDir: testDir,
      dryRun: false,
      defaultLeaseTtlMs: 600000,
    });
    
    let updated = await store.get(parent.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("blocked");

    // Complete subtask (ready → in-progress → review → done)
    // Note: child was already auto-promoted to ready by scheduler
    const childStatus = await store.get(child.frontmatter.id);
    expect(childStatus?.frontmatter.status).toBe("ready");
    
    await store.transition(child.frontmatter.id, "in-progress", {
      agent: "test",
      reason: "test start",
    });
    await store.transition(child.frontmatter.id, "review", {
      agent: "test",
      reason: "test review",
    });
    await store.transition(child.frontmatter.id, "done", {
      agent: "test",
      reason: "test completion",
    });

    // Run scheduler - parent should be requeued from blocked to ready
    const result = await poll(store, logger, {
      dataDir: testDir,
      dryRun: false,
      defaultLeaseTtlMs: 600000,
    });
    
    updated = await store.get(parent.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("ready");
    
    // Check that requeue action was logged (not promote, since it was blocked → ready)
    const requeueAction = result.actions.find(a => 
      a.type === "requeue" && a.taskId === parent.frontmatter.id
    );
    expect(requeueAction).toBeDefined();
  });

  it("should not promote task without routing target", async () => {
    // Create task without routing
    const task = await store.create({
      title: "Task without routing",
      priority: "normal",
      routing: {},  // No agent/role/team
      createdBy: "test",
    });

    // Run scheduler - task should stay in backlog
    const result = await poll(store, logger, {
      dataDir: testDir,
      dryRun: false,
      defaultLeaseTtlMs: 600000,
    });
    
    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("backlog");
    
    // No promote action should exist
    const promoteAction = result.actions.find(a => 
      a.type === "promote" && a.taskId === task.frontmatter.id
    );
    expect(promoteAction).toBeUndefined();
  });

  it("should promote task with no dependencies or subtasks", async () => {
    // Create standalone task
    const task = await store.create({
      title: "Standalone task",
      priority: "normal",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });

    // Run scheduler - task should promote immediately
    const result = await poll(store, logger, {
      dataDir: testDir,
      dryRun: false,
      defaultLeaseTtlMs: 600000,
    });
    
    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("ready");
    
    // Check that promote action was logged
    const promoteAction = result.actions.find(a => 
      a.type === "promote" && a.taskId === task.frontmatter.id
    );
    expect(promoteAction).toBeDefined();
  });
});
