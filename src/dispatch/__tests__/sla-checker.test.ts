import { describe, it, expect, beforeEach } from "vitest";
import { SLAChecker } from "../sla-checker.js";
import type { Task } from "../../schemas/task.js";
import { DEFAULT_SLA_CONFIG } from "../../config/sla-defaults.js";

describe("SLAChecker", () => {
  let checker: SLAChecker;

  beforeEach(() => {
    checker = new SLAChecker({ rateLimitMinutes: 15 });
  });

  describe("checkViolations", () => {
    it("returns no violations for empty task list", () => {
      const violations = checker.checkViolations([], {});
      expect(violations).toHaveLength(0);
    });

    it("ignores tasks that are not in-progress", () => {
      const now = Date.now();
      const tasks: Task[] = [
        createTask("TASK-001", "ready", now - 7200000), // 2 hours old, ready
        createTask("TASK-002", "done", now - 7200000),  // 2 hours old, done
      ];

      const violations = checker.checkViolations(tasks, {});
      expect(violations).toHaveLength(0);
    });

    it("detects SLA violation when task exceeds default limit", () => {
      const now = Date.now();
      const twoHoursAgo = now - 7200000; // 2 hours
      const tasks: Task[] = [
        createTask("TASK-001", "in-progress", twoHoursAgo),
      ];

      const violations = checker.checkViolations(tasks, {});
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        taskId: "TASK-001",
        duration: expect.any(Number),
        limit: DEFAULT_SLA_CONFIG.defaultMaxInProgressMs, // 1 hour
      });
      expect(violations[0]!.duration).toBeGreaterThan(DEFAULT_SLA_CONFIG.defaultMaxInProgressMs);
    });

    it("does not flag tasks within SLA limit", () => {
      const now = Date.now();
      const thirtyMinutesAgo = now - 1800000; // 30 minutes
      const tasks: Task[] = [
        createTask("TASK-001", "in-progress", thirtyMinutesAgo),
      ];

      const violations = checker.checkViolations(tasks, {});
      expect(violations).toHaveLength(0);
    });

    it("uses per-task SLA override when present", () => {
      const now = Date.now();
      const twoHoursAgo = now - 7200000; // 2 hours
      const tasks: Task[] = [
        createTask("TASK-001", "in-progress", twoHoursAgo, {
          sla: { maxInProgressMs: 14400000 }, // 4 hours override
        }),
      ];

      const violations = checker.checkViolations(tasks, {});
      expect(violations).toHaveLength(0); // 2 hours < 4 hours = no violation
    });

    it("uses research SLA for research agent tasks", () => {
      const now = Date.now();
      const twoHoursAgo = now - 7200000; // 2 hours
      const tasks: Task[] = [
        createTask("TASK-001", "in-progress", twoHoursAgo, {
          routing: { agent: "swe-researcher" },
        }),
      ];

      const violations = checker.checkViolations(tasks, {});
      expect(violations).toHaveLength(0); // 2 hours < 4 hours (research default) = no violation
    });

    it("uses project SLA defaults when configured", () => {
      const now = Date.now();
      const fortyFiveMinutesAgo = now - 2700000; // 45 minutes
      const tasks: Task[] = [
        createTask("TASK-001", "in-progress", fortyFiveMinutesAgo),
      ];

      const projectSLA = {
        sla: {
          defaultMaxInProgressMs: 1800000, // 30 minutes (stricter than default 1 hour)
        },
      };

      const violations = checker.checkViolations(tasks, projectSLA);
      expect(violations).toHaveLength(1); // 45 minutes > 30 minutes = violation
    });

    it("includes task metadata in violation", () => {
      const now = Date.now();
      const twoHoursAgo = now - 7200000;
      const tasks: Task[] = [
        createTask("TASK-001", "in-progress", twoHoursAgo, {
          title: "Long running task",
          routing: { agent: "swe-backend" },
        }),
      ];

      const violations = checker.checkViolations(tasks, {});
      expect(violations[0]).toMatchObject({
        taskId: "TASK-001",
        title: "Long running task",
        agent: "swe-backend",
        timestamp: expect.any(Number),
      });
    });
  });

  describe("shouldAlert", () => {
    it("returns true for first alert on a task", () => {
      expect(checker.shouldAlert("TASK-001")).toBe(true);
    });

    it("returns false if alert was sent recently", () => {
      checker.recordAlert("TASK-001");
      expect(checker.shouldAlert("TASK-001")).toBe(false);
    });

    it("returns true after rate limit window expires", () => {
      const fastChecker = new SLAChecker({ rateLimitMinutes: 0.001 }); // ~60ms
      
      fastChecker.recordAlert("TASK-001");
      expect(fastChecker.shouldAlert("TASK-001")).toBe(false);
      
      // Wait for rate limit to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(fastChecker.shouldAlert("TASK-001")).toBe(true);
          resolve();
        }, 100);
      });
    });

    it("tracks alerts separately per task", () => {
      checker.recordAlert("TASK-001");
      expect(checker.shouldAlert("TASK-001")).toBe(false);
      expect(checker.shouldAlert("TASK-002")).toBe(true);
    });

    it("allows multiple alerts after rate limit expires for same task", () => {
      const fastChecker = new SLAChecker({ rateLimitMinutes: 0.001 });
      
      fastChecker.recordAlert("TASK-001");
      
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(fastChecker.shouldAlert("TASK-001")).toBe(true);
          fastChecker.recordAlert("TASK-001");
          expect(fastChecker.shouldAlert("TASK-001")).toBe(false);
          resolve();
        }, 100);
      });
    });
  });

  describe("recordAlert", () => {
    it("prevents immediate re-alert for same task", () => {
      checker.recordAlert("TASK-001");
      expect(checker.shouldAlert("TASK-001")).toBe(false);
    });

    it("allows recording multiple alerts over time", () => {
      checker.recordAlert("TASK-001");
      checker.recordAlert("TASK-001"); // Should be tracked even if rate-limited
      
      const history = (checker as any).alertHistory.get("TASK-001");
      expect(history).toHaveLength(2);
    });
  });

  describe("rate limit pruning", () => {
    it("prunes old alerts outside rate limit window", () => {
      const fastChecker = new SLAChecker({ rateLimitMinutes: 0.001 });
      
      fastChecker.recordAlert("TASK-001");
      
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          fastChecker.shouldAlert("TASK-001"); // Triggers pruning
          const history = (fastChecker as any).alertHistory.get("TASK-001");
          expect(history).toHaveLength(0); // Old alert should be pruned
          resolve();
        }, 100);
      });
    });
  });
});

// Test helper to create task objects
function createTask(
  id: string,
  status: Task["frontmatter"]["status"],
  updatedAt: number,
  overrides: Partial<Task["frontmatter"]> = {}
): Task {
  return {
    frontmatter: {
      schemaVersion: 1,
      id,
      project: "test-project",
      title: overrides.title ?? "Test task",
      status,
      priority: "normal",
      routing: overrides.routing ?? {},
      sla: overrides.sla,
      createdAt: new Date(updatedAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      lastTransitionAt: new Date(updatedAt).toISOString(),
      createdBy: "test",
      dependsOn: [],
      metadata: {},
    },
    body: "Test task body",
  };
}
