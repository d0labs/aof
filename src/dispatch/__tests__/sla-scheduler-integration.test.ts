import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import writeFileAtomic from "write-file-atomic";
import { FilesystemTaskStore, serializeTask } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";

describe("Scheduler SLA Integration", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-sla-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects SLA violations for in-progress tasks", async () => {
    // Create an in-progress task that's 2 hours old (exceeds 1hr default)
    const task = await store.create({
      title: "Old task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    
    // Manually set updatedAt to 2 hours ago
    const taskData = await store.get(task.frontmatter.id);
    if (taskData) {
      const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
      taskData.frontmatter.updatedAt = twoHoursAgo;
      await writeFileAtomic(taskData.path!, serializeTask(taskData));
    }

    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: true,
      defaultLeaseTtlMs: 600_000,
    });

    // Should have an SLA violation action
    const slaActions = result.actions.filter(a => a.type === "sla_violation");
    expect(slaActions).toHaveLength(1);
    expect(slaActions[0]).toMatchObject({
      type: "sla_violation",
      taskId: task.frontmatter.id,
      taskTitle: "Old task",
    });
  });

  it("does not flag tasks within SLA limit", async () => {
    // Create an in-progress task that's 30 minutes old (within 1hr default)
    const task = await store.create({
      title: "Recent task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    
    // Set updatedAt to 30 minutes ago
    const taskData = await store.get(task.frontmatter.id);
    if (taskData) {
      const thirtyMinutesAgo = new Date(Date.now() - 1800000).toISOString();
      taskData.frontmatter.updatedAt = thirtyMinutesAgo;
      await writeFileAtomic(taskData.path!, serializeTask(taskData));
    }

    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: true,
      defaultLeaseTtlMs: 600_000,
    });

    // Should have no SLA violation actions
    const slaActions = result.actions.filter(a => a.type === "sla_violation");
    expect(slaActions).toHaveLength(0);
  });

  it("respects per-task SLA overrides", async () => {
    // Create task with 4-hour SLA override
    const task = await store.create({
      title: "Long task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
      sla: { maxInProgressMs: 14400000 }, // 4 hours
    });
    
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    
    // Set updatedAt to 2 hours ago (within 4hr limit)
    const taskData = await store.get(task.frontmatter.id);
    if (taskData) {
      const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
      taskData.frontmatter.updatedAt = twoHoursAgo;
      await writeFileAtomic(taskData.path!, serializeTask(taskData));
    }

    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: true,
      defaultLeaseTtlMs: 600_000,
    });

    // Should have no SLA violation (2hr < 4hr)
    const slaActions = result.actions.filter(a => a.type === "sla_violation");
    expect(slaActions).toHaveLength(0);
  });

  it("rate-limits SLA alerts for the same task", async () => {
    // Create an in-progress task that's 2 hours old
    const task = await store.create({
      title: "Old task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    
    const taskData = await store.get(task.frontmatter.id);
    if (taskData) {
      const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
      taskData.frontmatter.updatedAt = twoHoursAgo;
      await writeFileAtomic(taskData.path!, serializeTask(taskData));
    }

    // Create a shared SLAChecker instance to maintain state across polls
    const { SLAChecker } = await import("../sla-checker.js");
    const slaChecker = new SLAChecker();

    // First poll - should detect violation and alert
    const result1 = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false, // Need active mode to track alerts
      defaultLeaseTtlMs: 600_000,
      slaChecker,
    });

    const slaActions1 = result1.actions.filter(a => a.type === "sla_violation");
    expect(slaActions1).toHaveLength(1);

    // Second poll immediately after - should be rate-limited
    const result2 = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      slaChecker, // Reuse the same instance
    });

    // Should still detect violation but not emit second alert
    const slaActions2 = result2.actions.filter(a => a.type === "sla_violation");
    expect(slaActions2).toHaveLength(1);
    // Metadata should indicate alert was not sent
    expect(slaActions2[0]!.reason).toContain("rate-limited");
  });

  it("logs SLA violations to events.jsonl", async () => {
    const task = await store.create({
      title: "Old task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    
    const taskData = await store.get(task.frontmatter.id);
    if (taskData) {
      const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
      taskData.frontmatter.updatedAt = twoHoursAgo;
      await writeFileAtomic(taskData.path!, serializeTask(taskData));
    }

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
    });

    // Check that SLA violation was logged
    const events = await logger.query({ type: "sla.violation" });
    expect(events.length).toBeGreaterThan(0);
    
    const slaEvent = events[0];
    expect(slaEvent).toMatchObject({
      type: "sla.violation",
      taskId: task.frontmatter.id,
    });
    expect(slaEvent!.payload).toMatchObject({
      duration: expect.any(Number),
      limit: expect.any(Number),
    });
  });

  it("ignores non-in-progress tasks", async () => {
    // Create tasks in various statuses
    const ready = await store.create({
      title: "Ready task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    await store.transition(ready.frontmatter.id, "ready");
    
    const blocked = await store.create({
      title: "Blocked task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    await store.transition(blocked.frontmatter.id, "ready");
    await store.transition(blocked.frontmatter.id, "blocked");
    
    const done = await store.create({
      title: "Done task",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    await store.transition(done.frontmatter.id, "ready");
    await store.transition(done.frontmatter.id, "in-progress");
    await store.transition(done.frontmatter.id, "review");
    await store.transition(done.frontmatter.id, "done");

    // Make them all 2 hours old
    for (const task of [ready, blocked, done]) {
      const taskData = await store.get(task.frontmatter.id);
      if (taskData) {
        const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
        taskData.frontmatter.updatedAt = twoHoursAgo;
        await writeFileAtomic(taskData.path!, serializeTask(taskData));
      }
    }

    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: true,
      defaultLeaseTtlMs: 600_000,
    });

    // Should have no SLA violations (none are in-progress)
    const slaActions = result.actions.filter(a => a.type === "sla_violation");
    expect(slaActions).toHaveLength(0);
  });

  it("handles multiple simultaneous violations", async () => {
    // Create 3 in-progress tasks that are all 2 hours old
    // NOTE: Tasks must be created sequentially to avoid ID collision race
    const tasks = [
      await store.create({ title: "Task 1", createdBy: "test", routing: { agent: "swe-backend" } }),
      await store.create({ title: "Task 2", createdBy: "test", routing: { agent: "swe-frontend" } }),
      await store.create({ title: "Task 3", createdBy: "test", routing: { agent: "swe-qa" } }),
    ];

    for (const task of tasks) {
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      
      const taskData = await store.get(task.frontmatter.id);
      if (taskData) {
        const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
        taskData.frontmatter.updatedAt = twoHoursAgo;
        await writeFileAtomic(taskData.path!, serializeTask(taskData));
      }
    }

    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: true,
      defaultLeaseTtlMs: 600_000,
    });

    // Should detect all 3 violations
    const slaActions = result.actions.filter(a => a.type === "sla_violation");
    expect(slaActions).toHaveLength(3);
  });
});
