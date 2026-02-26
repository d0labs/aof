/**
 * AOF-adf: Scheduler dispatch throttling and concurrency control tests.
 * 
 * Tests cover:
 * 1. Global concurrency limit enforcement
 * 2. Global minimum dispatch interval enforcement
 * 3. Per-poll dispatch limit enforcement
 * 4. Per-team concurrency override
 * 5. Per-team interval override
 * 6. Default config allows reasonable throughput
 * 7. Throttle logging is informative
 * 8. Dry-run mode doesn't update throttle state
 * 9. Multiple teams throttled independently
 * 10. Throttle state persists across poll cycles
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll, resetThrottleState } from "../scheduler.js";
import { MockAdapter } from "../executor.js";

describe("Scheduler Throttling (AOF-adf)", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let executor: MockAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-throttle-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
    executor = new MockAdapter();
    
    // Reset global throttle state between tests
    resetThrottleState();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Test 1: Global concurrency limit enforced
   * When N tasks are in-progress and N >= maxConcurrentDispatches,
   * no new tasks should be dispatched.
   */
  it("enforces global concurrency limit", async () => {
    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 2,
      minDispatchIntervalMs: 0, // Disable interval check
      maxDispatchesPerPoll: 10, // Disable per-poll check
      executor,
    };

    // Create 2 in-progress tasks (at capacity)
    for (let i = 0; i < 2; i++) {
      const task = await store.create({
        title: `In-progress ${i}`,
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
    }

    // Create 2 ready tasks
    for (let i = 0; i < 2; i++) {
      const task = await store.create({
        title: `Ready ${i}`,
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    const result = await poll(store, logger, config);

    // Should detect ready tasks but not dispatch due to concurrency limit
    expect(result.stats.ready).toBe(2);
    expect(result.stats.inProgress).toBe(2);
    const assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions).toHaveLength(0);
  });

  /**
   * Test 2: Global minimum dispatch interval enforced
   * When time since last dispatch < minDispatchIntervalMs,
   * no new tasks should be dispatched.
   */
  it("enforces global minimum dispatch interval", async () => {
    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 10, // High limit
      minDispatchIntervalMs: 10_000, // 10 seconds
      maxDispatchesPerPoll: 10, // Disable per-poll check
      executor,
    };

    // Create 3 ready tasks
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        title: `Ready ${i}`,
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    // First poll - dispatches all 3 (interval only throttles between polls)
    const result1 = await poll(store, logger, config);
    const assignActions1 = result1.actions.filter(a => a.type === "assign");
    expect(assignActions1).toHaveLength(3);

    // Create more ready tasks for second poll
    for (let i = 0; i < 2; i++) {
      const task = await store.create({
        title: `Ready extra ${i}`,
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    // Immediate second poll - should NOT dispatch (interval not elapsed)
    const result2 = await poll(store, logger, config);
    const assignActions2 = result2.actions.filter(a => a.type === "assign");
    expect(assignActions2).toHaveLength(0);
  });

  /**
   * Test 3: Per-poll dispatch limit enforced
   * When dispatches in this poll cycle >= maxDispatchesPerPoll,
   * remaining tasks should not be dispatched.
   */
  it("enforces per-poll dispatch limit", async () => {
    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 10, // High limit
      minDispatchIntervalMs: 0, // Disable interval check
      maxDispatchesPerPoll: 2, // Only 2 per poll
      executor,
    };

    // Create 5 ready tasks
    for (let i = 0; i < 5; i++) {
      const task = await store.create({
        title: `Ready ${i}`,
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    const result = await poll(store, logger, config);

    // Should dispatch exactly 2 tasks (per-poll limit)
    const assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions).toHaveLength(2);
  });

  /**
   * Test 4: Per-team concurrency override works
   * Team with maxConcurrent=1 should only allow 1 in-progress task.
   */
  it("enforces per-team concurrency override", async () => {
    // Create org chart with team override
    const orgChart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-backend", name: "Backend Engineer", team: "backend-team" },
      ],
      teams: [
        {
          id: "backend-team",
          name: "Backend Team",
          dispatch: {
            maxConcurrent: 1, // Only 1 concurrent task for this team
          },
        },
      ],
    };
    await writeFile(join(tmpDir, "org-chart.yaml"), stringifyYaml(orgChart));

    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 10, // High global limit
      minDispatchIntervalMs: 0,
      maxDispatchesPerPoll: 10,
      executor,
    };

    // Create 1 in-progress task for backend-team
    const task1 = await store.create({
      title: "In-progress backend",
      createdBy: "main",
      routing: { team: "backend-team", agent: "swe-backend" },
    });
    await store.transition(task1.frontmatter.id, "ready");
    await store.transition(task1.frontmatter.id, "in-progress");

    // Create 2 ready tasks for backend-team
    for (let i = 0; i < 2; i++) {
      const task = await store.create({
        title: `Ready backend ${i}`,
        createdBy: "main",
        routing: { team: "backend-team", agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    const result = await poll(store, logger, config);

    // Should NOT dispatch (team at capacity)
    const assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions).toHaveLength(0);
  });

  /**
   * Test 5: Per-team interval override works
   * Team with minIntervalMs=5000 should throttle dispatches accordingly.
   */
  it("enforces per-team interval override", async () => {
    // Create org chart with team override
    const orgChart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-backend", name: "Backend Engineer", team: "backend-team" },
      ],
      teams: [
        {
          id: "backend-team",
          name: "Backend Team",
          dispatch: {
            minIntervalMs: 10_000, // 10 seconds between backend dispatches
          },
        },
      ],
    };
    await writeFile(join(tmpDir, "org-chart.yaml"), stringifyYaml(orgChart));

    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 10,
      minDispatchIntervalMs: 0, // No global interval
      maxDispatchesPerPoll: 10,
      executor,
    };

    // Create 3 ready tasks for backend-team
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        title: `Ready backend ${i}`,
        createdBy: "main",
        routing: { team: "backend-team", agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    // First poll - dispatches all 3 (per-team interval only throttles between polls)
    const result1 = await poll(store, logger, config);
    const assignActions1 = result1.actions.filter(a => a.type === "assign");
    expect(assignActions1).toHaveLength(3);

    // Create more ready tasks for second poll
    for (let i = 0; i < 2; i++) {
      const task = await store.create({
        title: `Ready backend extra ${i}`,
        createdBy: "main",
        routing: { team: "backend-team", agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    // Immediate second poll - should NOT dispatch (team interval not elapsed)
    const result2 = await poll(store, logger, config);
    const assignActions2 = result2.actions.filter(a => a.type === "assign");
    expect(assignActions2).toHaveLength(0);
  });

  /**
   * Test 6: Default config allows reasonable throughput
   * With conservative defaults (max=3, interval=0, perPoll=10), single agent should not feel throttled.
   */
  it("default config allows reasonable throughput", async () => {
    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 3, // Default
      minDispatchIntervalMs: 0, // Default (disabled)
      maxDispatchesPerPoll: 10, // Default (effectively disabled)
      executor,
    };

    // Create 2 ready tasks
    for (let i = 0; i < 2; i++) {
      const task = await store.create({
        title: `Ready ${i}`,
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    const result = await poll(store, logger, config);

    // Should dispatch both tasks (under all limits, no throttling)
    const assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions).toHaveLength(2);
  });

  /**
   * Test 7: Throttle logging is informative
   * When throttling kicks in, log should explain which limit was hit.
   */
  it("logs informative throttle messages", async () => {
    const consoleInfoSpy = vi.spyOn(console, "info");

    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 1, // Low limit to trigger throttle
      minDispatchIntervalMs: 0,
      maxDispatchesPerPoll: 10,
      executor,
    };

    // Create 1 in-progress + 1 ready task
    const task1 = await store.create({
      title: "In-progress",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task1.frontmatter.id, "ready");
    await store.transition(task1.frontmatter.id, "in-progress");

    const task2 = await store.create({
      title: "Ready",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task2.frontmatter.id, "ready");

    await poll(store, logger, config);

    // Should log throttle reason
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dispatch throttled")
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining("global concurrency")
    );

    consoleInfoSpy.mockRestore();
  });

  /**
   * Test 8: Dry-run mode doesn't update throttle state
   * In dry-run mode, throttle state should not be modified.
   */
  it("dry-run mode does not update throttle state", async () => {
    const config = {
      dataDir: tmpDir,
      dryRun: true, // Dry-run mode
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 10,
      minDispatchIntervalMs: 1000,
      maxDispatchesPerPoll: 10,
      executor,
    };

    // Create 2 ready tasks
    for (let i = 0; i < 2; i++) {
      const task = await store.create({
        title: `Ready ${i}`,
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    // First dry-run poll
    const result1 = await poll(store, logger, config);
    const assignActions1 = result1.actions.filter(a => a.type === "assign");
    expect(assignActions1).toHaveLength(2);

    // Second dry-run poll - should still show 2 assign actions (state not updated)
    const result2 = await poll(store, logger, config);
    const assignActions2 = result2.actions.filter(a => a.type === "assign");
    expect(assignActions2).toHaveLength(2);
  });

  /**
   * Test 9: Multiple teams throttled independently
   * Two teams with different limits should throttle independently.
   */
  it("throttles multiple teams independently", async () => {
    // Create org chart with two teams
    const orgChart = {
      schemaVersion: 1,
      agents: [
        { id: "swe-backend", name: "Backend Engineer", team: "backend-team" },
        { id: "swe-frontend", name: "Frontend Engineer", team: "frontend-team" },
      ],
      teams: [
        {
          id: "backend-team",
          name: "Backend Team",
          dispatch: { maxConcurrent: 1 },
        },
        {
          id: "frontend-team",
          name: "Frontend Team",
          dispatch: { maxConcurrent: 2 },
        },
      ],
    };
    await writeFile(join(tmpDir, "org-chart.yaml"), stringifyYaml(orgChart));

    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 10, // High global limit
      minDispatchIntervalMs: 0,
      maxDispatchesPerPoll: 10,
      executor,
    };

    // Backend team: 1 in-progress (at capacity)
    const backend1 = await store.create({
      title: "Backend in-progress",
      createdBy: "main",
      routing: { team: "backend-team", agent: "swe-backend" },
    });
    await store.transition(backend1.frontmatter.id, "ready");
    await store.transition(backend1.frontmatter.id, "in-progress");

    // Frontend team: 1 in-progress (under capacity)
    const frontend1 = await store.create({
      title: "Frontend in-progress",
      createdBy: "main",
      routing: { team: "frontend-team", agent: "swe-frontend" },
    });
    await store.transition(frontend1.frontmatter.id, "ready");
    await store.transition(frontend1.frontmatter.id, "in-progress");

    // Ready tasks: 1 backend, 1 frontend
    const backend2 = await store.create({
      title: "Backend ready",
      createdBy: "main",
      routing: { team: "backend-team", agent: "swe-backend" },
    });
    await store.transition(backend2.frontmatter.id, "ready");

    const frontend2 = await store.create({
      title: "Frontend ready",
      createdBy: "main",
      routing: { team: "frontend-team", agent: "swe-frontend" },
    });
    await store.transition(frontend2.frontmatter.id, "ready");

    const result = await poll(store, logger, config);

    // Backend should be throttled (at capacity), frontend should dispatch
    const assignActions = result.actions.filter(a => a.type === "assign");
    expect(assignActions).toHaveLength(1);
    expect(assignActions[0]!.taskId).toBe(frontend2.frontmatter.id);
  });

  /**
   * Test 10: Throttle state persists across poll cycles
   * Interval tracking should work across multiple poll cycles.
   */
  it("throttle state persists across poll cycles", async () => {
    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 10,
      minDispatchIntervalMs: 10_000, // 10 seconds
      maxDispatchesPerPoll: 1, // Only 1 per poll
      executor,
    };

    // Create 3 ready tasks
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        title: `Ready ${i}`,
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    // Poll 1 - dispatch 1 task
    const result1 = await poll(store, logger, config);
    const assignActions1 = result1.actions.filter(a => a.type === "assign");
    expect(assignActions1).toHaveLength(1);

    // Poll 2 (immediate) - should NOT dispatch (interval not elapsed)
    const result2 = await poll(store, logger, config);
    const assignActions2 = result2.actions.filter(a => a.type === "assign");
    expect(assignActions2).toHaveLength(0);

    // Poll 3 (immediate) - still should NOT dispatch
    const result3 = await poll(store, logger, config);
    const assignActions3 = result3.actions.filter(a => a.type === "assign");
    expect(assignActions3).toHaveLength(0);
  });

  /**
   * Test 11: Throttle does not block promotion
   * Backlog → ready promotions should not be affected by dispatch throttling.
   */
  it("throttle does not block promotion", async () => {
    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 0, // Block all dispatches
      minDispatchIntervalMs: 0,
      maxDispatchesPerPoll: 0,
      executor,
    };

    // Create backlog task (eligible for promotion)
    const task = await store.create({
      title: "Backlog task",
      createdBy: "main",
      routing: { agent: "swe-backend" },
    });
    // Task starts in backlog by default

    const result = await poll(store, logger, config);

    // Should promote even when dispatches are throttled
    const promoteActions = result.actions.filter(a => a.type === "promote");
    expect(promoteActions).toHaveLength(1);
  });

  /**
   * Test 12: Zero minDispatchIntervalMs disables interval check
   * Setting minDispatchIntervalMs=0 should allow back-to-back dispatches.
   */
  it("zero minDispatchIntervalMs disables interval check", async () => {
    const config = {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      maxConcurrentDispatches: 10,
      minDispatchIntervalMs: 0, // Disabled
      maxDispatchesPerPoll: 2,
      executor,
    };

    // Create 2 ready tasks
    for (let i = 0; i < 2; i++) {
      const task = await store.create({
        title: `Ready ${i}`,
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");
    }

    // First poll - should dispatch 2 tasks
    const result1 = await poll(store, logger, config);
    const assignActions1 = result1.actions.filter(a => a.type === "assign");
    expect(assignActions1).toHaveLength(2);
  });
});
