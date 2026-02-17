/**
 * End-to-end integration tests for murmur orchestration system.
 *
 * Tests the full murmur cycle:
 * 1. Trigger evaluation (scheduler detects conditions)
 * 2. Context building (orchestrator brief assembly)
 * 3. State management (review tracking across cycles)
 * 4. Review dispatch and completion
 * 5. Cleanup (stale review detection)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { OrgTeam } from "../../schemas/org-chart.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";
import type { Task } from "../../schemas/task.js";
import { MurmurStateManager } from "../state-manager.js";
import { evaluateTriggers, type TaskStats } from "../trigger-evaluator.js";
import { buildReviewContext } from "../context-builder.js";
import { cleanupStaleReview } from "../cleanup.js";
import { evaluateMurmurTriggers, type MurmurIntegrationOptions } from "../../dispatch/murmur-integration.js";

describe("Murmur E2E Integration", () => {
  const testStateDir = ".test-murmur-state";
  const testDocsDir = ".test-murmur-docs";
  let stateManager: MurmurStateManager;
  let mockStore: ITaskStore;
  let mockLogger: EventLogger;
  let mockTeam: OrgTeam;
  let taskIdCounter = 0;

  beforeEach(async () => {
    // Clean up test directories
    await rm(testStateDir, { recursive: true, force: true });
    await rm(testDocsDir, { recursive: true, force: true });
    await mkdir(testStateDir, { recursive: true });
    await mkdir(testDocsDir, { recursive: true });

    // Reset counter
    taskIdCounter = 0;

    // Initialize state manager
    stateManager = new MurmurStateManager({
      stateDir: testStateDir,
    });

    // Create mock logger
    mockLogger = createMockLogger();

    // Create default team config with queueEmpty trigger
    mockTeam = {
      id: "backend-team",
      name: "Backend Team",
      description: "Backend development team",
      orchestrator: "swe-pm",
      murmur: {
        triggers: [{ kind: "queueEmpty" }],
        context: ["taskSummary"],
      },
    };

    // Create mock store
    mockStore = createMockStore();
  });

  afterEach(async () => {
    await rm(testStateDir, { recursive: true, force: true });
    await rm(testDocsDir, { recursive: true, force: true });
  });

  describe("Full Murmur Cycle - Happy Path", () => {
    test("should complete full cycle: empty queue → trigger → review → completion → state clear", async () => {
      // PHASE 1: Initial state - queue has tasks
      const tasks = [
        createMockTask("TASK-001", "ready", "Implement feature"),
        createMockTask("TASK-002", "in-progress", "Fix bug"),
      ];
      mockStore.list = vi.fn().mockResolvedValue(tasks);

      // Load initial state
      const initialState = await stateManager.load(mockTeam.id);
      expect(initialState.currentReviewTaskId).toBeNull();

      // Evaluate triggers - should NOT fire (queue not empty)
      const taskStats: TaskStats = {
        ready: 1,
        inProgress: 1,
      };
      const result1 = evaluateTriggers(mockTeam.murmur!.triggers, initialState, taskStats);
      expect(result1.shouldFire).toBe(false);

      // PHASE 2: Complete all tasks → queue becomes empty
      const completedTasks = tasks.map((t) => ({
        ...t,
        frontmatter: { ...t.frontmatter, status: "done" as const },
      }));
      mockStore.list = vi.fn().mockResolvedValue(completedTasks);

      // Update state to reflect completions
      await stateManager.incrementCompletions(mockTeam.id);
      await stateManager.incrementCompletions(mockTeam.id);

      const stateAfterCompletions = await stateManager.load(mockTeam.id);
      expect(stateAfterCompletions.completionsSinceLastReview).toBe(2);

      // Evaluate triggers - should FIRE (queue empty)
      const emptyTaskStats: TaskStats = {
        ready: 0,
        inProgress: 0,
      };
      const result2 = evaluateTriggers(
        mockTeam.murmur!.triggers,
        stateAfterCompletions,
        emptyTaskStats
      );
      expect(result2.shouldFire).toBe(true);
      expect(result2.triggeredBy).toBe("queueEmpty");
      expect(result2.reason).toContain("empty");

      // PHASE 3: Build review context
      mockStore.countByStatus = vi.fn().mockResolvedValue({
        done: 2,
      });

      const reviewContext = await buildReviewContext(
        mockTeam,
        stateAfterCompletions,
        mockStore,
        { docsBasePath: testDocsDir }
      );

      expect(reviewContext).toContain("# Orchestration Review");
      expect(reviewContext).toContain("**Team:** Backend Team");
      expect(reviewContext).toContain("## Task Summary");
      expect(reviewContext).toContain("**Completed**: 2 tasks");

      // PHASE 4: Start review - create review task and update state
      const reviewTaskId = nextTaskId();
      await stateManager.startReview(mockTeam.id, reviewTaskId, "queueEmpty");

      const stateWithReview = await stateManager.load(mockTeam.id);
      expect(stateWithReview.currentReviewTaskId).toBe(reviewTaskId);
      expect(stateWithReview.lastTriggeredBy).toBe("queueEmpty");
      expect(stateWithReview.completionsSinceLastReview).toBe(0); // Reset on review start
      expect(stateWithReview.lastReviewAt).toBeTruthy();

      // PHASE 5: Verify idempotency - trigger should NOT fire again
      const result3 = evaluateTriggers(
        mockTeam.murmur!.triggers,
        stateWithReview,
        emptyTaskStats
      );
      expect(result3.shouldFire).toBe(false); // Blocked by currentReviewTaskId

      // PHASE 6: Complete review - orchestrator creates new tasks
      await stateManager.endReview(mockTeam.id);

      const stateFinal = await stateManager.load(mockTeam.id);
      expect(stateFinal.currentReviewTaskId).toBeNull();
      expect(stateFinal.lastReviewAt).toBeTruthy(); // Still tracks last review time
      expect(stateFinal.lastTriggeredBy).toBe("queueEmpty"); // Still tracks what fired last
    });
  });

  describe("Trigger Conditions", () => {
    test("should not fire queueEmpty trigger when ready queue has tasks", async () => {
      const state = await stateManager.load(mockTeam.id);
      const taskStats: TaskStats = {
        ready: 3,
        inProgress: 0,
      };

      const result = evaluateTriggers(mockTeam.murmur!.triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBeNull();
    });

    test("should not fire queueEmpty trigger when in-progress queue has tasks", async () => {
      const state = await stateManager.load(mockTeam.id);
      const taskStats: TaskStats = {
        ready: 0,
        inProgress: 2,
      };

      const result = evaluateTriggers(mockTeam.murmur!.triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBeNull();
    });

    test("should fire completionBatch trigger when threshold met", async () => {
      // Configure team with completionBatch trigger
      mockTeam.murmur!.triggers = [
        { kind: "completionBatch", threshold: 5 },
      ];

      const state = await stateManager.load(mockTeam.id);

      // Simulate 5 completions
      for (let i = 0; i < 5; i++) {
        await stateManager.incrementCompletions(mockTeam.id);
      }

      const updatedState = await stateManager.load(mockTeam.id);
      const taskStats: TaskStats = { ready: 10, inProgress: 2 };

      const result = evaluateTriggers(mockTeam.murmur!.triggers, updatedState, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("completionBatch");
      expect(result.reason).toContain("5");
    });

    test("should respect trigger priority - first matching trigger wins", async () => {
      // Configure multiple triggers
      mockTeam.murmur!.triggers = [
        { kind: "completionBatch", threshold: 3 },
        { kind: "queueEmpty" },
      ];

      // Both conditions are met
      for (let i = 0; i < 3; i++) {
        await stateManager.incrementCompletions(mockTeam.id);
      }

      const state = await stateManager.load(mockTeam.id);
      const taskStats: TaskStats = { ready: 0, inProgress: 0 };

      const result = evaluateTriggers(mockTeam.murmur!.triggers, state, taskStats);

      // completionBatch should fire first (listed first)
      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("completionBatch");
    });
  });

  describe("Double-Fire Prevention", () => {
    test("should prevent concurrent reviews via currentReviewTaskId guard", async () => {
      // Start a review
      const reviewTaskId = nextTaskId();
      await stateManager.startReview(mockTeam.id, reviewTaskId, "queueEmpty");

      const state = await stateManager.load(mockTeam.id);
      const taskStats: TaskStats = { ready: 0, inProgress: 0 };

      // Try to fire trigger again
      const result = evaluateTriggers(mockTeam.murmur!.triggers, state, taskStats);

      expect(result.shouldFire).toBe(false);
      expect(result.triggeredBy).toBeNull();
      expect(state.currentReviewTaskId).toBe(reviewTaskId);
    });

    test("should allow new review after previous review completes", async () => {
      // Start and complete first review
      const reviewTaskId1 = nextTaskId();
      await stateManager.startReview(mockTeam.id, reviewTaskId1, "queueEmpty");
      await stateManager.endReview(mockTeam.id);

      // State should allow new reviews
      const state = await stateManager.load(mockTeam.id);
      expect(state.currentReviewTaskId).toBeNull();

      const taskStats: TaskStats = { ready: 0, inProgress: 0 };
      const result = evaluateTriggers(mockTeam.murmur!.triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("queueEmpty");
    });
  });

  describe("Stale Review Cleanup", () => {
    test("should detect and clean up stale review when task not found", async () => {
      const reviewTaskId = nextTaskId();
      await stateManager.startReview(mockTeam.id, reviewTaskId, "queueEmpty");

      // Mock store returns null (task doesn't exist)
      mockStore.get = vi.fn().mockResolvedValue(null);

      const state = await stateManager.load(mockTeam.id);
      const cleanupResult = await cleanupStaleReview(
        mockTeam.id,
        state,
        mockStore,
        stateManager,
        mockLogger
      );

      expect(cleanupResult.cleaned).toBe(true);
      expect(cleanupResult.reason).toBe("task_not_found");
      expect(cleanupResult.cleanedTaskId).toBe(reviewTaskId);

      // State should be cleared
      const finalState = await stateManager.load(mockTeam.id);
      expect(finalState.currentReviewTaskId).toBeNull();
    });

    test("should detect and clean up stale review when task completed", async () => {
      const reviewTaskId = nextTaskId();
      await stateManager.startReview(mockTeam.id, reviewTaskId, "queueEmpty");

      // Mock store returns completed task
      const completedTask = createMockTask(reviewTaskId, "done", "Review task");
      mockStore.get = vi.fn().mockResolvedValue(completedTask);

      const state = await stateManager.load(mockTeam.id);
      const cleanupResult = await cleanupStaleReview(
        mockTeam.id,
        state,
        mockStore,
        stateManager,
        mockLogger
      );

      expect(cleanupResult.cleaned).toBe(true);
      expect(cleanupResult.reason).toBe("task_done");
      expect(cleanupResult.cleanedTaskId).toBe(reviewTaskId);

      const finalState = await stateManager.load(mockTeam.id);
      expect(finalState.currentReviewTaskId).toBeNull();
    });

    test("should detect and clean up stale review after timeout", async () => {
      const reviewTaskId = nextTaskId();

      // Manually create state with old timestamp
      const oldTimestamp = new Date(Date.now() - 40 * 60 * 1000).toISOString(); // 40 minutes ago
      const state = await stateManager.load(mockTeam.id);
      state.currentReviewTaskId = reviewTaskId;
      state.reviewStartedAt = oldTimestamp;
      await stateManager.save(mockTeam.id, state);

      // Mock store returns in-progress task
      const activeTask = createMockTask(reviewTaskId, "in-progress", "Review task");
      mockStore.get = vi.fn().mockResolvedValue(activeTask);

      const loadedState = await stateManager.load(mockTeam.id);
      const cleanupResult = await cleanupStaleReview(
        mockTeam.id,
        loadedState,
        mockStore,
        stateManager,
        mockLogger,
        { reviewTimeoutMs: 30 * 60 * 1000 } // 30 minute timeout
      );

      expect(cleanupResult.cleaned).toBe(true);
      expect(cleanupResult.reason).toBe("timeout");
      expect(cleanupResult.cleanedTaskId).toBe(reviewTaskId);

      const finalState = await stateManager.load(mockTeam.id);
      expect(finalState.currentReviewTaskId).toBeNull();
    });

    test("should not clean up active review within timeout", async () => {
      const reviewTaskId = nextTaskId();
      await stateManager.startReview(mockTeam.id, reviewTaskId, "queueEmpty");

      // Mock store returns in-progress task
      const activeTask = createMockTask(reviewTaskId, "in-progress", "Review task");
      mockStore.get = vi.fn().mockResolvedValue(activeTask);

      const state = await stateManager.load(mockTeam.id);
      const cleanupResult = await cleanupStaleReview(
        mockTeam.id,
        state,
        mockStore,
        stateManager,
        mockLogger,
        { reviewTimeoutMs: 30 * 60 * 1000 }
      );

      expect(cleanupResult.cleaned).toBe(false);
      expect(cleanupResult.reason).toBeNull();

      // State should remain unchanged
      const finalState = await stateManager.load(mockTeam.id);
      expect(finalState.currentReviewTaskId).toBe(reviewTaskId);
    });
  });

  describe("Integration: evaluateMurmurTriggers", () => {
    test("should evaluate triggers and create review task when conditions met", async () => {
      // Setup: empty queue
      mockStore.list = vi.fn().mockResolvedValue([]);
      mockStore.countByStatus = vi.fn().mockResolvedValue({});

      const createdReviewTask = createMockTask(nextTaskId(), "ready", "Orchestration Review");
      mockStore.create = vi.fn().mockResolvedValue(createdReviewTask);
      mockStore.transition = vi.fn().mockResolvedValue(createdReviewTask);

      const options: MurmurIntegrationOptions = {
        store: mockStore,
        logger: mockLogger,
        stateManager,
        dryRun: false,
        defaultLeaseTtlMs: 30000,
        maxConcurrentDispatches: 10,
        currentInProgress: 0,
      };

      const result = await evaluateMurmurTriggers([mockTeam], options);

      expect(result.teamsEvaluated).toBe(1);
      expect(result.reviewsTriggered).toBe(1);
      expect(mockStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("Orchestration Review"),
          routing: expect.objectContaining({
            agent: "swe-pm",
            team: "backend-team",
          }),
        })
      );

      // State should be updated
      const state = await stateManager.load(mockTeam.id);
      expect(state.currentReviewTaskId).toBe(createdReviewTask.frontmatter.id);
      expect(state.lastTriggeredBy).toBe("queueEmpty");
    });

    test("should skip evaluation when concurrency limit reached", async () => {
      mockStore.list = vi.fn().mockResolvedValue([]);

      const options: MurmurIntegrationOptions = {
        store: mockStore,
        logger: mockLogger,
        stateManager,
        dryRun: false,
        defaultLeaseTtlMs: 30000,
        maxConcurrentDispatches: 5,
        currentInProgress: 5, // At limit
      };

      const result = await evaluateMurmurTriggers([mockTeam], options);

      expect(result.teamsEvaluated).toBe(1);
      expect(result.reviewsTriggered).toBe(1);
      expect(result.reviewsSkipped).toBe(1); // Skipped due to concurrency
      expect(mockStore.create).not.toHaveBeenCalled();
    });

    test("should handle multiple teams with different trigger conditions", async () => {
      const team1: OrgTeam = {
        id: "backend-team",
        name: "Backend Team",
        orchestrator: "swe-pm",
        murmur: {
          triggers: [{ kind: "queueEmpty" }],
          context: ["taskSummary"],
        },
      };

      const team2: OrgTeam = {
        id: "frontend-team",
        name: "Frontend Team",
        orchestrator: "swe-pm",
        murmur: {
          triggers: [{ kind: "completionBatch", threshold: 10 }],
          context: ["taskSummary"],
        },
      };

      // Backend team has empty queue (should trigger)
      // Frontend team has only 2 completions (should not trigger)
      await stateManager.incrementCompletions(team2.id);
      await stateManager.incrementCompletions(team2.id);

      mockStore.list = vi.fn().mockResolvedValue([]);
      mockStore.countByStatus = vi.fn().mockResolvedValue({});
      mockStore.create = vi.fn().mockImplementation((params) => {
        const task = createMockTask(nextTaskId(), "ready", params.title);
        return Promise.resolve(task);
      });
      mockStore.transition = vi.fn().mockImplementation((id) => {
        const task = createMockTask(id, "ready", "Review task");
        return Promise.resolve(task);
      });

      const options: MurmurIntegrationOptions = {
        store: mockStore,
        logger: mockLogger,
        stateManager,
        dryRun: false,
        defaultLeaseTtlMs: 30000,
        maxConcurrentDispatches: 10,
        currentInProgress: 0,
      };

      const result = await evaluateMurmurTriggers([team1, team2], options);

      expect(result.teamsEvaluated).toBe(2);
      expect(result.reviewsTriggered).toBe(1); // Only backend team
      expect(result.reviewsSkipped).toBe(1); // Frontend team
      expect(mockStore.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("Failure Counter Tracking", () => {
    test("should track failures and fire failureBatch trigger", async () => {
      // Configure failureBatch trigger
      mockTeam.murmur!.triggers = [
        { kind: "failureBatch", threshold: 3 },
      ];

      // Simulate 3 failures
      for (let i = 0; i < 3; i++) {
        await stateManager.incrementFailures(mockTeam.id);
      }

      const state = await stateManager.load(mockTeam.id);
      expect(state.failuresSinceLastReview).toBe(3);

      const taskStats: TaskStats = { ready: 5, inProgress: 2 };
      const result = evaluateTriggers(mockTeam.murmur!.triggers, state, taskStats);

      expect(result.shouldFire).toBe(true);
      expect(result.triggeredBy).toBe("failureBatch");
      expect(result.reason).toContain("3");
    });

    test("should reset failure counter when review starts", async () => {
      // Track some failures
      await stateManager.incrementFailures(mockTeam.id);
      await stateManager.incrementFailures(mockTeam.id);

      const stateBefore = await stateManager.load(mockTeam.id);
      expect(stateBefore.failuresSinceLastReview).toBe(2);

      // Start review
      const reviewTaskId = nextTaskId();
      await stateManager.startReview(mockTeam.id, reviewTaskId, "queueEmpty");

      const stateAfter = await stateManager.load(mockTeam.id);
      expect(stateAfter.failuresSinceLastReview).toBe(0);
    });
  });

  // Helper functions

  function nextTaskId(): string {
    taskIdCounter++;
    return `TASK-2026-02-17-${String(taskIdCounter).padStart(3, "0")}`;
  }

  function createMockStore(): ITaskStore {
    return {
      projectRoot: testDocsDir,
      projectId: "TEST",
      tasksDir: join(testDocsDir, "tasks"),
      init: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      get: vi.fn(),
      getByPrefix: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      countByStatus: vi.fn().mockResolvedValue({}),
      transition: vi.fn(),
      cancel: vi.fn(),
      updateBody: vi.fn(),
      update: vi.fn(),
      touch: vi.fn(),
      computeReadyTasks: vi.fn(),
      acquireLease: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn(),
      getDependents: vi.fn(),
      isStale: vi.fn(),
    } as unknown as ITaskStore;
  }

  function createMockLogger(): EventLogger {
    return {
      log: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      streamQuery: vi.fn(),
    } as unknown as EventLogger;
  }

  function createMockTask(id: string, status: string, title: string): Task {
    return {
      frontmatter: {
        schemaVersion: 1,
        id,
        project: "TEST",
        title,
        status: status as any,
        priority: "normal",
        routing: {},
        createdAt: "2026-02-17T09:00:00.000Z",
        updatedAt: "2026-02-17T10:00:00.000Z",
        lastTransitionAt: "2026-02-17T10:00:00.000Z",
        createdBy: "system",
        dependsOn: [],
        metadata: {},
        gateHistory: [],
        tests: [],
      },
      body: "Task body content",
    };
  }
});
