/**
 * Tests for gate context builder — progressive disclosure for task payloads.
 */

import { describe, it, expect } from "vitest";
import { buildGateContext, type GateContext } from "../gate-context-builder.js";
import type { Gate } from "../../schemas/gate.js";
import type { Task } from "../../schemas/task.js";
import type { WorkflowConfig } from "../../schemas/workflow.js";

describe("buildGateContext", () => {
  const baseTask: Task = {
    frontmatter: {
      schemaVersion: 1,
      id: "TASK-2026-02-17-001",
      project: "test",
      title: "Test task",
      status: "in-progress",
      priority: "normal",
      routing: { role: "swe-backend" },
      createdAt: "2026-02-17T00:00:00Z",
      updatedAt: "2026-02-17T00:00:00Z",
      lastTransitionAt: "2026-02-17T00:00:00Z",
      createdBy: "test",
      dependsOn: [],
      metadata: {},
      gateHistory: [],
      tests: [],
    },
    body: "Test body",
  };

  const implementGate: Gate = {
    id: "implement",
    role: "swe-backend",
    canReject: false,
    description: "Implement the feature with TDD",
  };

  const reviewGate: Gate = {
    id: "code-review",
    role: "swe-architect",
    canReject: true,
    description: "Review for TDD compliance, test coverage ≥80%, architecture, error handling",
  };

  const approvalGate: Gate = {
    id: "approval",
    role: "swe-pm",
    canReject: false,
    requireHuman: true,
    description: "Final approval before deployment",
  };

  const baseWorkflow: WorkflowConfig = {
    name: "standard",
    rejectionStrategy: "origin",
    gates: [implementGate, reviewGate, approvalGate],
  };

  describe("role descriptions", () => {
    it("should generate implementation role for non-rejecting gate", () => {
      const context = buildGateContext(baseTask, implementGate, baseWorkflow);
      expect(context.role).toContain("working on");
      expect(context.role).not.toContain("reviewing");
    });

    it("should generate review role for rejecting gate", () => {
      const context = buildGateContext(baseTask, reviewGate, baseWorkflow);
      expect(context.role).toContain("reviewing");
      expect(context.role).toContain("quality");
    });

    it("should generate approval role for human-required gate", () => {
      const context = buildGateContext(baseTask, approvalGate, baseWorkflow);
      expect(context.role).toContain("approval");
    });

    it("should fall back gracefully when gate has no description", () => {
      const basicGate: Gate = {
        id: "implement",
        role: "swe-backend",
        canReject: false,
      };

      const context = buildGateContext(baseTask, basicGate, baseWorkflow);
      expect(context.role).toBe("You are working on the implement stage.");
      expect(context.expectations).toContain("Complete the work described in the task");
    });

    it("should adapt role for rejection loop-back", () => {
      const taskWithReview: Task = {
        ...baseTask,
        frontmatter: {
          ...baseTask.frontmatter,
          reviewContext: {
            fromGate: "code-review",
            fromRole: "swe-architect",
            timestamp: "2026-02-17T01:00:00Z",
            blockers: ["Test coverage too low"],
          },
        },
      };

      const context = buildGateContext(taskWithReview, implementGate, baseWorkflow);
      expect(context.role).toContain("fixing issues");
      expect(context.role).toContain("previous review");
    });
  });

  describe("expectations", () => {
    it("should list standard implementation expectations", () => {
      const context = buildGateContext(baseTask, implementGate, baseWorkflow);
      expect(context.expectations).toContain("Complete the work described in the task");
      expect(context.expectations).toContain("Implement the feature with TDD");
    });

    it("should list review expectations for rejecting gate", () => {
      const context = buildGateContext(baseTask, reviewGate, baseWorkflow);
      expect(context.expectations).toContain("Review for quality and correctness");
      expect(context.expectations).toContain("Check for security issues");
    });

    it("should focus on blockers when in rejection loop", () => {
      const taskWithReview: Task = {
        ...baseTask,
        frontmatter: {
          ...baseTask.frontmatter,
          reviewContext: {
            fromGate: "code-review",
            fromRole: "swe-architect",
            timestamp: "2026-02-17T01:00:00Z",
            blockers: ["Test coverage too low", "Missing error handling"],
          },
        },
      };

      const context = buildGateContext(taskWithReview, implementGate, baseWorkflow);
      expect(context.expectations).toContain("Address ALL blockers listed in reviewContext below");
      expect(context.expectations).toContain("Re-run tests and coverage checks");
    });
  });

  describe("outcomes", () => {
    it("should describe complete outcome with next gate", () => {
      const context = buildGateContext(baseTask, implementGate, baseWorkflow);
      expect(context.outcomes.complete).toContain("code-review");
    });

    it("should describe complete outcome for last gate", () => {
      const context = buildGateContext(baseTask, approvalGate, baseWorkflow);
      expect(context.outcomes.complete).toContain("complete");
      expect(context.outcomes.complete).toContain("done");
    });

    it("should describe needs_review for rejecting gate", () => {
      const context = buildGateContext(baseTask, reviewGate, baseWorkflow);
      expect(context.outcomes.needs_review).toContain("fixes");
      expect(context.outcomes.needs_review).toContain("back");
    });

    it("should mark needs_review as not applicable for non-rejecting gate", () => {
      const context = buildGateContext(baseTask, implementGate, baseWorkflow);
      expect(context.outcomes.needs_review).toContain("Not applicable");
    });
  });

  describe("tips", () => {
    it("should provide tips for review gates", () => {
      const context = buildGateContext(baseTask, reviewGate, baseWorkflow);
      expect(context.tips).toBeDefined();
      expect(context.tips?.length).toBeGreaterThan(0);
      expect(context.tips?.some(tip => tip.includes("specific"))).toBe(true);
    });

    it("should provide review feedback count when blockers exist", () => {
      const taskWithReview: Task = {
        ...baseTask,
        frontmatter: {
          ...baseTask.frontmatter,
          reviewContext: {
            fromGate: "code-review",
            fromRole: "swe-architect",
            timestamp: "2026-02-17T01:00:00Z",
            blockers: ["Issue 1", "Issue 2", "Issue 3"],
          },
        },
      };

      const context = buildGateContext(taskWithReview, implementGate, baseWorkflow);
      expect(context.tips).toBeDefined();
      expect(context.tips?.some(tip => tip.includes("3 issues"))).toBe(true);
    });

    it("should not provide tips for basic implementation gates", () => {
      const basicGate: Gate = {
        id: "implement",
        role: "swe-backend",
        canReject: false,
      };

      const context = buildGateContext(baseTask, basicGate, baseWorkflow);
      // Tips may be undefined if no relevant guidance
      if (context.tips) {
        expect(context.tips.length).toBe(0);
      }
    });
  });

  describe("gate field", () => {
    it("should include gate ID", () => {
      const context = buildGateContext(baseTask, reviewGate, baseWorkflow);
      expect(context.gate).toBe("code-review");
    });
  });

  describe("work type detection", () => {
    it("should detect feature work type", () => {
      const featureTask: Task = {
        ...baseTask,
        frontmatter: {
          ...baseTask.frontmatter,
          routing: { role: "swe-backend", tags: ["feature"] },
        },
      };

      const context = buildGateContext(featureTask, reviewGate, baseWorkflow);
      expect(context.role).toContain("feature");
    });

    it("should detect bug fix work type", () => {
      const bugTask: Task = {
        ...baseTask,
        frontmatter: {
          ...baseTask.frontmatter,
          routing: { role: "swe-backend", tags: ["bug"] },
        },
      };

      const context = buildGateContext(bugTask, reviewGate, baseWorkflow);
      expect(context.role).toContain("bug fix");
    });

    it("should detect docs work type", () => {
      const docsTask: Task = {
        ...baseTask,
        frontmatter: {
          ...baseTask.frontmatter,
          routing: { role: "swe-tech-writer", tags: ["docs"] },
        },
      };

      const context = buildGateContext(docsTask, reviewGate, baseWorkflow);
      expect(context.role).toContain("documentation");
    });

    it("should default to 'work' when no tags match", () => {
      const context = buildGateContext(baseTask, reviewGate, baseWorkflow);
      expect(context.role).toContain("work");
    });
  });
});
