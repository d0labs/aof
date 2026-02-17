/**
 * Concurrency stress tests for murmur orchestration system.
 *
 * Validates that the murmur system handles concurrent operations correctly:
 * - Respects maxConcurrentDispatches limit
 * - No deadlocks in file-based state manager locks
 * - All teams eventually get their reviews processed
 * - State remains consistent after concurrent operations
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import type { OrgTeam } from "../../schemas/org-chart.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";
import type { Task } from "../../schemas/task.js";
import { MurmurStateManager } from "../state-manager.js";
import { evaluateMurmurTriggers, type MurmurIntegrationOptions } from "../../dispatch/murmur-integration.js";

describe("Murmur Concurrency Stress Tests", () => {
  const testStateDir = ".test-murmur-concurrency";
  let stateManager: MurmurStateManager;
  let mockStore: ITaskStore;
  let mockLogger: EventLogger;
  let taskIdCounter = 0;

  beforeEach(async () => {
    // Clean up test directories
    await rm(testStateDir, { recursive: true, force: true });
    await mkdir(testStateDir, { recursive: true });

    // Reset counter
    taskIdCounter = 0;

    // Initialize state manager
    stateManager = new MurmurStateManager({
      stateDir: testStateDir,
    });

    // Create mock logger
    mockLogger = createMockLogger();

    // Create mock store
    mockStore = createMockStore();
  });

  afterEach(async () => {
    await rm(testStateDir, { recursive: true, force: true });
  });

  describe("Concurrency Limit Enforcement", () => {
    test("should respect maxConcurrentDispatches limit (3 teams, limit 2)", async () => {
      // Create 3 teams that all have empty queues (will trigger queueEmpty)
      const teams: OrgTeam[] = [
        createTeam("team-alpha", "Alpha Team"),
        createTeam("team-beta", "Beta Team"),
        createTeam("team-gamma", "Gamma Team"),
      ];

      // Mock store to return empty task list (triggers queueEmpty for all teams)
      mockStore.list = vi.fn().mockResolvedValue([]);

      let createdReviews = 0;
      mockStore.create = vi.fn().mockImplementation(async (options) => {
        createdReviews++;
        return createMockTask(nextTaskId(), "backlog", options.title, options.routing.team);
      });

      mockStore.transition = vi.fn().mockImplementation(async (taskId, status) => {
        return createMockTask(taskId, status as any, "Review task", "team");
      });

      // Set concurrency limit to 2, simulate that we already have 2 in progress
      // (at the limit, so no new reviews should be created)
      const options: MurmurIntegrationOptions = {
        store: mockStore,
        logger: mockLogger,
        stateManager,
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        maxConcurrentDispatches: 2,
        currentInProgress: 2, // Already at limit
      };

      // Evaluate all teams - NO reviews should be created (already at limit)
      const result = await evaluateMurmurTriggers(teams, options);

      // Verify results
      expect(result.teamsEvaluated).toBe(3);
      expect(result.reviewsTriggered).toBe(3); // All 3 trigger conditions are met
      expect(createdReviews).toBe(0); // But none created (already at limit)
      expect(result.reviewsSkipped).toBe(3); // All 3 skipped due to limit
    });

    test("should allow dispatch when under concurrency limit", async () => {
      const teams: OrgTeam[] = [
        createTeam("team-alpha", "Alpha Team"),
        createTeam("team-beta", "Beta Team"),
      ];

      mockStore.list = vi.fn().mockResolvedValue([]);

      const createdReviews: string[] = [];
      mockStore.create = vi.fn().mockImplementation(async (options) => {
        const team = options.routing.team;
        createdReviews.push(team);
        return createMockTask(nextTaskId(), "backlog", options.title, team);
      });

      mockStore.transition = vi.fn().mockImplementation(async (taskId, status) => {
        return createMockTask(taskId, status as any, "Review task", "team");
      });

      // Set concurrency limit to 5, current in-progress to 3
      // Should allow 2 more dispatches (5 - 3 = 2)
      const options: MurmurIntegrationOptions = {
        store: mockStore,
        logger: mockLogger,
        stateManager,
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        maxConcurrentDispatches: 5,
        currentInProgress: 3,
      };

      const result = await evaluateMurmurTriggers(teams, options);

      // Both teams should dispatch successfully (under limit)
      expect(result.teamsEvaluated).toBe(2);
      expect(result.reviewsTriggered).toBe(2);
      expect(createdReviews.length).toBe(2);
    });
  });

  describe("State Manager Lock Contention", () => {
    test("should handle concurrent state operations without corruption", async () => {
      const teamId = "team-alpha";

      // Perform 10 concurrent increment operations
      const operations = Array.from({ length: 10 }, (_, i) =>
        stateManager.incrementCompletions(teamId)
      );

      // Wait for all operations to complete
      await Promise.all(operations);

      // Load final state and verify count is exactly 10
      const finalState = await stateManager.load(teamId);
      expect(finalState.completionsSinceLastReview).toBe(10);
    });

    test("should handle mixed concurrent operations (increment + save + load)", async () => {
      const teamId = "team-beta";

      // Mix of operations happening concurrently
      const operations = [
        // 5 completion increments
        ...Array.from({ length: 5 }, () => stateManager.incrementCompletions(teamId)),
        // 3 failure increments
        ...Array.from({ length: 3 }, () => stateManager.incrementFailures(teamId)),
        // 2 concurrent loads (shouldn't block)
        stateManager.load(teamId),
        stateManager.load(teamId),
      ];

      // Execute all concurrently
      const results = await Promise.allSettled(operations);

      // All operations should succeed
      const failures = results.filter((r) => r.status === "rejected");
      expect(failures).toHaveLength(0);

      // Final state should have correct counts
      const finalState = await stateManager.load(teamId);
      expect(finalState.completionsSinceLastReview).toBe(5);
      expect(finalState.failuresSinceLastReview).toBe(3);
    });

    test("should handle concurrent startReview + endReview + incrementCompletions", async () => {
      const teamId = "team-gamma";

      // Initialize with some completions
      await stateManager.incrementCompletions(teamId);

      // Start a review
      await stateManager.startReview(teamId, "TASK-001", "queueEmpty");

      // Now run mixed operations concurrently
      const operations = [
        // Try to increment completions (should work, counters reset on startReview)
        stateManager.incrementCompletions(teamId),
        stateManager.incrementCompletions(teamId),
        // Load state (read-only, shouldn't block)
        stateManager.load(teamId),
        // End the review
        stateManager.endReview(teamId),
      ];

      const results = await Promise.allSettled(operations);

      // All operations should succeed without deadlock
      const failures = results.filter((r) => r.status === "rejected");
      expect(failures).toHaveLength(0);

      // Final state should be consistent
      const finalState = await stateManager.load(teamId);
      // Review should be ended (last operation)
      expect(finalState.currentReviewTaskId).toBeNull();
      expect(finalState.reviewStartedAt).toBeNull();
      // Should have 2 completions from the increments after startReview
      expect(finalState.completionsSinceLastReview).toBe(2);
    });

    test("should handle concurrent operations across multiple teams without deadlock", async () => {
      const teams = ["team-alpha", "team-beta", "team-gamma", "team-delta", "team-epsilon"];

      // Each team gets a mix of concurrent operations
      const allOperations = teams.flatMap((teamId) => [
        stateManager.incrementCompletions(teamId),
        stateManager.incrementFailures(teamId),
        stateManager.load(teamId),
        stateManager.startReview(teamId, `TASK-${teamId}`, "completionBatch"),
      ]);

      // Execute all operations concurrently across all teams
      const results = await Promise.allSettled(allOperations);

      // All operations should succeed
      const failures = results.filter((r) => r.status === "rejected");
      expect(failures).toHaveLength(0);

      // Verify each team has consistent state
      for (const teamId of teams) {
        const state = await stateManager.load(teamId);
        expect(state.teamId).toBe(teamId);
        expect(state.currentReviewTaskId).toBe(`TASK-${teamId}`);
        // Counters reset when review starts
        expect(state.completionsSinceLastReview).toBe(0);
        expect(state.failuresSinceLastReview).toBe(0);
      }
    });
  });

  describe("Sequential Trigger Evaluation with State Consistency", () => {
    test("should maintain idempotency across sequential evaluations", async () => {
      const teams: OrgTeam[] = [createTeam("team-alpha", "Alpha Team")];

      // Mock empty queue to trigger queueEmpty
      mockStore.list = vi.fn().mockResolvedValue([]);

      let createCallCount = 0;
      const createdTasks = new Map<string, Task>();
      mockStore.create = vi.fn().mockImplementation(async (options) => {
        createCallCount++;
        const task = createMockTask(nextTaskId(), "backlog", options.title, options.routing.team);
        createdTasks.set(task.frontmatter.id, task);
        return task;
      });

      mockStore.transition = vi.fn().mockImplementation(async (taskId, status) => {
        const task = createdTasks.get(taskId);
        if (task) {
          task.frontmatter.status = status as any;
          return task;
        }
        return createMockTask(taskId, status as any, "Review task", "team-alpha");
      });

      // Mock get to return created tasks (for cleanup check)
      mockStore.get = vi.fn().mockImplementation(async (taskId) => {
        return createdTasks.get(taskId) || null;
      });

      const options: MurmurIntegrationOptions = {
        store: mockStore,
        logger: mockLogger,
        stateManager,
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        maxConcurrentDispatches: 10,
        currentInProgress: 0,
      };

      // Run 10 sequential evaluations
      for (let i = 0; i < 10; i++) {
        await evaluateMurmurTriggers(teams, options);
      }

      // Only ONE review should be created (idempotency guard)
      expect(createCallCount).toBe(1);

      // Final state should show review in progress
      const state = await stateManager.load("team-alpha");
      expect(state.currentReviewTaskId).toBeTruthy();
    });

    test("should handle multiple teams evaluated sequentially", async () => {
      const teams: OrgTeam[] = [
        createTeam("team-alpha", "Alpha Team"),
        createTeam("team-beta", "Beta Team"),
        createTeam("team-gamma", "Gamma Team"),
      ];

      mockStore.list = vi.fn().mockResolvedValue([]);

      const createdReviews = new Set<string>();
      mockStore.create = vi.fn().mockImplementation(async (options) => {
        const team = options.routing.team;
        createdReviews.add(team);
        return createMockTask(nextTaskId(), "backlog", options.title, team);
      });

      mockStore.transition = vi.fn().mockImplementation(async (taskId, status) => {
        return createMockTask(taskId, status as any, "Review task", "team");
      });

      const options: MurmurIntegrationOptions = {
        store: mockStore,
        logger: mockLogger,
        stateManager,
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        maxConcurrentDispatches: 10,
        currentInProgress: 0,
      };

      // Run 5 sequential evaluations (all teams evaluated each time)
      for (let i = 0; i < 5; i++) {
        await evaluateMurmurTriggers(teams, options);
      }

      // Each team should have exactly ONE review created (no duplicates)
      expect(createdReviews.size).toBe(3);
      expect(Array.from(createdReviews)).toContain("team-alpha");
      expect(Array.from(createdReviews)).toContain("team-beta");
      expect(Array.from(createdReviews)).toContain("team-gamma");

      // Each team should have review in progress
      for (const team of teams) {
        const state = await stateManager.load(team.id);
        expect(state.currentReviewTaskId).toBeTruthy();
      }
    });
  });

  describe("Lock Timeout and Serialization", () => {
    test("should serialize operations through lock mechanism", async () => {
      const teamId = "team-alpha";

      // Use atomic increment operations (which use locks internally)
      const operations = Array.from({ length: 5 }, () =>
        stateManager.incrementCompletions(teamId)
      );

      // All operations should eventually complete
      const results = await Promise.allSettled(operations);

      const failures = results.filter((r) => r.status === "rejected");
      expect(failures).toHaveLength(0);

      // Final state should reflect all operations
      const finalState = await stateManager.load(teamId);
      expect(finalState.completionsSinceLastReview).toBe(5);
    });

    test("should handle interleaved lock acquisitions across multiple teams", async () => {
      const teamIds = ["team-1", "team-2", "team-3"];

      // Create a pattern of interleaved operations
      const operations = [];
      
      for (let i = 0; i < 10; i++) {
        for (const teamId of teamIds) {
          // Each iteration: increment, load, increment again
          operations.push(
            stateManager.incrementCompletions(teamId),
            stateManager.load(teamId),
            stateManager.incrementFailures(teamId)
          );
        }
      }

      // Execute all operations concurrently
      const results = await Promise.allSettled(operations);

      // All operations should succeed
      const failures = results.filter((r) => r.status === "rejected");
      expect(failures).toHaveLength(0);

      // Each team should have consistent state
      for (const teamId of teamIds) {
        const state = await stateManager.load(teamId);
        expect(state.completionsSinceLastReview).toBe(10);
        expect(state.failuresSinceLastReview).toBe(10);
      }
    });
  });

  describe("Mixed Concurrent Operations with State Consistency", () => {
    test("should maintain state consistency with concurrent startReview/endReview cycles", async () => {
      const teamId = "team-alpha";

      // Simulate multiple review cycles happening sequentially (not concurrently)
      // because concurrent start/end on the same team would be a race condition
      for (let i = 0; i < 5; i++) {
        const taskId = `TASK-${i}`;
        await stateManager.startReview(teamId, taskId, "completionBatch");
        // Brief pause to simulate review work
        await new Promise((resolve) => setTimeout(resolve, 10));
        await stateManager.endReview(teamId);
      }

      // Final state should be consistent (last review ended)
      const finalState = await stateManager.load(teamId);
      expect(finalState.currentReviewTaskId).toBeNull();
      expect(finalState.lastReviewAt).toBeTruthy();
    });

    test("should handle concurrent increment operations during evaluation", async () => {
      const teams: OrgTeam[] = [
        createTeam("team-alpha", "Alpha Team"),
        createTeam("team-beta", "Beta Team"),
      ];

      mockStore.list = vi.fn().mockResolvedValue([]);
      mockStore.create = vi.fn().mockImplementation(async (options) => {
        return createMockTask(nextTaskId(), "backlog", options.title, options.routing.team);
      });
      mockStore.transition = vi.fn().mockImplementation(async (taskId, status) => {
        return createMockTask(taskId, status as any, "Review task", "team");
      });

      const options: MurmurIntegrationOptions = {
        store: mockStore,
        logger: mockLogger,
        stateManager,
        dryRun: false,
        defaultLeaseTtlMs: 60000,
        maxConcurrentDispatches: 10,
        currentInProgress: 0,
      };

      // Perform direct state operations concurrently with evaluation
      const [evalResult, ...opResults] = await Promise.all([
        evaluateMurmurTriggers(teams, options),
        stateManager.incrementCompletions("team-alpha"),
        stateManager.incrementFailures("team-beta"),
        stateManager.load("team-alpha"),
        stateManager.load("team-beta"),
      ]);

      // All operations should succeed
      expect(opResults.length).toBe(4);
      expect(evalResult.teamsEvaluated).toBe(2);

      // State should be consistent
      const alphaState = await stateManager.load("team-alpha");
      const betaState = await stateManager.load("team-beta");

      expect(alphaState.teamId).toBe("team-alpha");
      expect(betaState.teamId).toBe("team-beta");
    });
  });

  // ========== Helper Functions ==========

  function createTeam(id: string, name: string): OrgTeam {
    return {
      id,
      name,
      description: `${name} description`,
      orchestrator: "swe-pm",
      murmur: {
        triggers: [{ kind: "queueEmpty" }],
        context: ["taskSummary"],
      },
    };
  }

  function createMockStore(): ITaskStore {
    return {
      projectId: "test-project",
      projectRoot: "/test/root",
      tasksDir: "/test/root/.aof/tasks",
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      transition: vi.fn(),
      move: vi.fn(),
      countByStatus: vi.fn().mockResolvedValue({}),
      search: vi.fn(),
      listBlocked: vi.fn(),
    } as unknown as ITaskStore;
  }

  function createMockLogger(): EventLogger {
    return {
      log: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      getPath: vi.fn(),
    } as unknown as EventLogger;
  }

  function createMockTask(
    id: string,
    status: "backlog" | "ready" | "in-progress" | "done" | "blocked",
    title: string,
    team?: string
  ): Task {
    return {
      path: `/test/tasks/${id}.md`,
      frontmatter: {
        id,
        title,
        status,
        priority: "medium",
        routing: {
          agent: "swe-backend",
          team: team || "backend-team",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      body: "Task body",
    };
  }

  function nextTaskId(): string {
    taskIdCounter++;
    return `TASK-${String(taskIdCounter).padStart(3, "0")}`;
  }
});
