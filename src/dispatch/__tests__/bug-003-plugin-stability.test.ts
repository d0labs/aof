/**
 * BUG-003: Plugin Reloading Frequently - Stability Tests
 * Date: 2026-02-08
 * 
 * Tests verify scheduler error handling prevents plugin crashes/restarts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { MockExecutor } from "../executor.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("BUG-003: Plugin Stability - Error Handling", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockExecutor;
  let events: BaseEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bug003-test-"));
    
    events = [];
    logger = new EventLogger(join(tmpDir, "events"), {
      onEvent: (event) => events.push(event),
    });
    
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
    
    executor = new MockExecutor();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("BUG-003: scheduler handles executor spawn errors gracefully", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Make executor throw an error
    executor.setShouldFail(true, "Spawn error");

    // Poll should not throw
    await expect(
      poll(store, logger, {
        dataDir: tmpDir,
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        executor,
      })
    ).resolves.toBeDefined();

    // Verify error was logged
    const errorEvents = events.filter(e => 
      e.type === "dispatch.error" || e.type === "action.completed"
    );
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it("BUG-003: scheduler handles store errors gracefully", async () => {
    // Create a corrupted store scenario by passing invalid dataDir
    const badStore = new FilesystemTaskStore("/nonexistent/path", { logger });

    // Poll should not throw
    await expect(
      poll(badStore, logger, {
        dataDir: "/nonexistent/path",
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        executor,
      })
    ).resolves.toBeDefined();
  });

  it("BUG-003: scheduler continues after individual action failure", async () => {
    const task1 = await store.create({
      title: "Task 1",
      body: "Body",
      routing: { agent: "agent-1" },
      createdBy: "test",
    });
    await store.transition(task1.frontmatter.id, "ready");

    const task2 = await store.create({
      title: "Task 2",
      body: "Body",
      routing: { agent: "agent-2" },
      createdBy: "test",
    });
    await store.transition(task2.frontmatter.id, "ready");

    // First spawn succeeds, second fails
    let spawnCount = 0;
    const originalSpawn = executor.spawn.bind(executor);
    executor.spawn = vi.fn(async (context, opts) => {
      spawnCount++;
      if (spawnCount === 1) {
        return originalSpawn(context, opts);
      } else {
        throw new Error("Second spawn fails");
      }
    });

    // Poll should handle both tasks without throwing
    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    expect(result.actions.length).toBe(2);
    // At least one should succeed
    expect(executor.spawn).toHaveBeenCalledTimes(2);
  });

  it("BUG-003: scheduler loop does not throw unhandled exceptions", async () => {
    // Create multiple tasks with various error scenarios
    const task1 = await store.create({
      title: "Normal task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task1.frontmatter.id, "ready");

    // Make executor throw
    executor.setShouldFail(true);

    // Multiple polls should all succeed without throwing
    for (let i = 0; i < 3; i++) {
      await expect(
        poll(store, logger, {
          dataDir: tmpDir,
          dryRun: false,
          defaultLeaseTtlMs: 60000,
          executor,
        })
      ).resolves.toBeDefined();
    }

    // Verify polls completed
    const pollEvents = events.filter(e => e.type === "scheduler.poll");
    expect(pollEvents.length).toBeGreaterThanOrEqual(3);
  });

  it("BUG-003: scheduler emits error events without crashing", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true, "Intentional failure");

    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Should have error event
    const errorEvent = events.find(e => e.type === "dispatch.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.payload?.error).toContain("failure");

    // Should still have poll event
    const pollEvent = events.find(e => e.type === "scheduler.poll");
    expect(pollEvent).toBeDefined();
  });

  it("BUG-003: logger errors do not crash scheduler", async () => {
    // Create logger that throws
    const badLogger = {
      ...logger,
      log: vi.fn().mockRejectedValue(new Error("Logger error")),
      logAction: vi.fn().mockRejectedValue(new Error("Logger error")),
      logDispatch: vi.fn().mockRejectedValue(new Error("Logger error")),
      logSchedulerPoll: vi.fn().mockRejectedValue(new Error("Logger error")),
    } as unknown as EventLogger;

    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Poll should complete despite logger errors
    await expect(
      poll(store, badLogger, {
        dataDir: tmpDir,
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        executor,
      })
    ).resolves.toBeDefined();
  });

  it("BUG-003: poll returns result even when all actions fail", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Body",
      routing: { agent: "test-agent" },
      createdBy: "test",
    });
    await store.transition(task.frontmatter.id, "ready");

    executor.setShouldFail(true);

    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 60000,
      executor,
    });

    // Result should be valid
    expect(result).toBeDefined();
    expect(result.actions).toBeDefined();
    expect(result.stats).toBeDefined();
    expect(result.scannedAt).toBeDefined();
  });
});
