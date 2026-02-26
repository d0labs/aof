/**
 * AOF-yea: Murmur scheduler integration tests
 *
 * Tests for murmur trigger evaluation, review task creation,
 * and state tracking hooks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import type { GatewayAdapter } from "../executor.js";
import { MurmurStateManager } from "../../murmur/state-manager.js";
import { stringify as stringifyYaml } from "yaml";
import { createMurmurHook } from "../murmur-hooks.js";

describe("Murmur Scheduler Integration", () => {
  let tmpDir: string;
  let store: FilesystemTaskStore;
  let logger: EventLogger;
  let stateManager: MurmurStateManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-murmur-test-"));
    stateManager = new MurmurStateManager({
      stateDir: join(tmpDir, ".murmur"),
    });
    
    // Create store with murmur hooks
    const murmurHook = createMurmurHook(tmpDir, stateManager);
    store = new FilesystemTaskStore(tmpDir, {
      projectId: "test-project",
      hooks: {
        afterTransition: murmurHook,
      },
    });
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("fires murmur trigger on queueEmpty and creates review task", async () => {
    // Create org chart with murmur config
    const orgChart = {
      schemaVersion: 1,
      agents: [],
      teams: [
        {
          id: "backend",
          name: "Backend Team",
          orchestrator: "agent-orchestrator",
          murmur: {
            triggers: [{ kind: "queueEmpty" }],
            context: ["taskSummary"],
          },
        },
      ],
    };

    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "org.yaml"),
      stringifyYaml(orgChart),
      "utf-8"
    );

    // Create a task for the team and complete it
    const task = await store.create({
      title: "Backend task",
      body: "Test task",
      routing: { team: "backend" },
      createdBy: "test",
    });

    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress", {
      agent: "agent-backend",
    });
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    // Mock executor that captures dispatch calls
    const dispatched: string[] = [];
    const mockExecutor: GatewayAdapter = {
      spawnSession: async (context) => {
        dispatched.push(context.taskId);
        return { success: true, sessionId: "test-session" };
      },
      getSessionStatus: async (sid) => ({ sessionId: sid, alive: false }),
      forceCompleteSession: async () => {},
    };

    // Run scheduler poll (should evaluate murmur triggers)
    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3,
    });

    // Check that a review task was created and dispatched
    const allTasks = await store.list();
    const reviewTasks = allTasks.filter(
      (t) => t.frontmatter.metadata?.kind === "orchestration_review"
    );

    expect(reviewTasks.length).toBe(1);
    expect(reviewTasks[0]!.frontmatter.routing.agent).toBe("agent-orchestrator");
    expect(reviewTasks[0]!.frontmatter.metadata?.murmurTrigger).toBe(
      "queueEmpty"
    );
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]).toBe(reviewTasks[0]!.frontmatter.id);

    // Check murmur state
    const state = await stateManager.load("backend");
    expect(state.currentReviewTaskId).toBe(reviewTasks[0]!.frontmatter.id);
    expect(state.lastTriggeredBy).toBe("queueEmpty");
  });

  it("skips murmur evaluation when review is already in progress", async () => {
    // Create org chart
    const orgChart = {
      schemaVersion: 1,
      agents: [],
      teams: [
        {
          id: "backend",
          name: "Backend Team",
          orchestrator: "agent-orchestrator",
          murmur: {
            triggers: [{ kind: "queueEmpty" }],
          },
        },
      ],
    };

    await writeFile(
      join(tmpDir, "org.yaml"),
      stringifyYaml(orgChart),
      "utf-8"
    );

    // Set murmur state to indicate review in progress
    await stateManager.startReview("backend", "existing-review", "queueEmpty");

    const mockExecutor: GatewayAdapter = {
      spawnSession: async () => ({ success: true, sessionId: "test-session" }),
      getSessionStatus: async (sid) => ({ sessionId: sid, alive: false }),
      forceCompleteSession: async () => {},
    };

    // Run scheduler poll
    const result = await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3,
    });

    // Check that no new review task was created
    const allTasks = await store.list();
    const reviewTasks = allTasks.filter(
      (t) => t.frontmatter.metadata?.kind === "orchestration_review"
    );

    expect(reviewTasks.length).toBe(0);
  });

  it("increments completion counter when task transitions to done", async () => {
    // Create task with team routing
    const task = await store.create({
      title: "Backend task",
      body: "Test task",
      routing: { team: "backend" },
      createdBy: "test",
    });

    // Complete the task (triggers murmur hook)
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress", {
      agent: "agent-backend",
    });
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    // Check murmur state
    const state = await stateManager.load("backend");
    expect(state.completionsSinceLastReview).toBe(1);
  });

  it("increments failure counter when task transitions to deadletter", async () => {
    // Create task with team routing
    const task = await store.create({
      title: "Backend task",
      body: "Test task",
      routing: { team: "backend" },
      createdBy: "test",
    });

    // Transition to deadletter (triggers murmur hook)
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "deadletter");

    // Check murmur state
    const state = await stateManager.load("backend");
    expect(state.failuresSinceLastReview).toBe(1);
  });

  it("ends review when orchestration review task completes", async () => {
    // Create review task
    const reviewTask = await store.create({
      title: "Orchestration Review",
      body: "Review context",
      routing: { team: "backend", agent: "agent-orchestrator" },
      metadata: {
        kind: "orchestration_review",
      },
      createdBy: "aof-scheduler",
    });

    // Set murmur state to indicate review in progress
    await stateManager.startReview(
      "backend",
      reviewTask.frontmatter.id,
      "queueEmpty"
    );

    // Complete the review task (triggers murmur hook)
    await store.transition(reviewTask.frontmatter.id, "ready");
    await store.transition(reviewTask.frontmatter.id, "in-progress", {
      agent: "agent-orchestrator",
    });
    await store.transition(reviewTask.frontmatter.id, "review");
    await store.transition(reviewTask.frontmatter.id, "done");

    // Check murmur state — review should be ended
    const state = await stateManager.load("backend");
    expect(state.currentReviewTaskId).toBeNull();
  });

  it("respects concurrency limit when dispatching review tasks", async () => {
    // Create org chart
    const orgChart = {
      schemaVersion: 1,
      agents: [],
      teams: [
        {
          id: "backend",
          name: "Backend Team",
          orchestrator: "agent-orchestrator",
          murmur: {
            triggers: [{ kind: "queueEmpty" }],
          },
        },
      ],
    };

    await writeFile(
      join(tmpDir, "org.yaml"),
      stringifyYaml(orgChart),
      "utf-8"
    );

    // Create 3 in-progress tasks (at concurrency limit)
    for (let i = 0; i < 3; i++) {
      const task = await store.create({
        title: `Task ${i}`,
        body: "Test",
        routing: { agent: "agent-backend" },
        createdBy: "test",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress", {
        agent: "agent-backend",
      });
    }

    const mockExecutor: GatewayAdapter = {
      spawnSession: async () => ({ success: true, sessionId: "test-session" }),
      getSessionStatus: async (sid) => ({ sessionId: sid, alive: false }),
      forceCompleteSession: async () => {},
    };

    // Run scheduler poll (should skip murmur due to concurrency limit)
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3,
    });

    // Check that no review task was created
    const allTasks = await store.list();
    const reviewTasks = allTasks.filter(
      (t) => t.frontmatter.metadata?.kind === "orchestration_review"
    );

    expect(reviewTasks.length).toBe(0);

    // Check that murmur state was not updated (review not started)
    const state = await stateManager.load("backend");
    expect(state.currentReviewTaskId).toBeNull();
  });

  it("skips teams without murmur config", async () => {
    // Create org chart with team lacking murmur config
    const orgChart = {
      schemaVersion: 1,
      agents: [],
      teams: [
        {
          id: "backend",
          name: "Backend Team",
          orchestrator: "agent-orchestrator",
          // No murmur config
        },
      ],
    };

    await writeFile(
      join(tmpDir, "org.yaml"),
      stringifyYaml(orgChart),
      "utf-8"
    );

    const mockExecutor: GatewayAdapter = {
      spawnSession: async () => ({ success: true, sessionId: "test-session" }),
      getSessionStatus: async (sid) => ({ sessionId: sid, alive: false }),
      forceCompleteSession: async () => {},
    };

    // Run scheduler poll
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3,
    });

    // Check that no review task was created
    const allTasks = await store.list();
    const reviewTasks = allTasks.filter(
      (t) => t.frontmatter.metadata?.kind === "orchestration_review"
    );

    expect(reviewTasks.length).toBe(0);
  });

  it("creates review task with correct metadata", async () => {
    // Create org chart
    const orgChart = {
      schemaVersion: 1,
      agents: [],
      teams: [
        {
          id: "backend",
          name: "Backend Team",
          orchestrator: "agent-orchestrator",
          murmur: {
            triggers: [{ kind: "completionBatch", threshold: 1 }],
            context: ["vision", "roadmap", "taskSummary"],
          },
        },
      ],
    };

    await writeFile(
      join(tmpDir, "org.yaml"),
      stringifyYaml(orgChart),
      "utf-8"
    );

    // Create and complete a task to trigger completionBatch
    const task = await store.create({
      title: "Backend task",
      body: "Test task",
      routing: { team: "backend" },
      createdBy: "test",
    });

    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress", {
      agent: "agent-backend",
    });
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    const mockExecutor: GatewayAdapter = {
      spawnSession: async () => ({ success: true, sessionId: "test-session" }),
      getSessionStatus: async (sid) => ({ sessionId: sid, alive: false }),
      forceCompleteSession: async () => {},
    };

    // Run scheduler poll
    await poll(store, logger, {
      dataDir: tmpDir,
      dryRun: false,
      defaultLeaseTtlMs: 600_000,
      executor: mockExecutor,
      maxConcurrentDispatches: 3,
    });

    // Check review task metadata
    const allTasks = await store.list();
    const reviewTask = allTasks.find(
      (t) => t.frontmatter.metadata?.kind === "orchestration_review"
    );

    expect(reviewTask).toBeDefined();
    expect(reviewTask!.frontmatter.title).toContain("Backend Team");
    expect(reviewTask!.frontmatter.routing.agent).toBe("agent-orchestrator");
    expect(reviewTask!.frontmatter.routing.team).toBe("backend");
    expect(reviewTask!.frontmatter.priority).toBe("high");
    expect(reviewTask!.frontmatter.metadata?.kind).toBe("orchestration_review");
    expect(reviewTask!.frontmatter.metadata?.murmurTrigger).toBe(
      "completionBatch"
    );
    expect(reviewTask!.frontmatter.metadata?.murmurReason).toContain(
      "threshold"
    );
  });

  it("does not increment counters for tasks without team routing", async () => {
    // Create task without team routing
    const task = await store.create({
      title: "Unassigned task",
      body: "Test task",
      routing: { agent: "agent-backend" }, // No team
      createdBy: "test",
    });

    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress", {
      agent: "agent-backend",
    });
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    // Check that no murmur state was created (no team)
    const state = await stateManager.load("backend");
    expect(state.completionsSinceLastReview).toBe(0);
  });
});
