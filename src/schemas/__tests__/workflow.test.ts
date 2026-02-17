/**
 * Tests for workflow configuration schema.
 */

import { describe, it, expect } from "vitest";
import {
  RejectionStrategy,
  WorkflowConfig,
  validateWorkflow,
} from "../workflow.js";

describe("RejectionStrategy", () => {
  it("accepts 'origin'", () => {
    const result = RejectionStrategy.safeParse("origin");
    expect(result.success).toBe(true);
  });

  it("rejects invalid strategy", () => {
    const result = RejectionStrategy.safeParse("invalid");
    expect(result.success).toBe(false);
  });

  it("defaults to 'origin'", () => {
    const schema = RejectionStrategy.default("origin");
    const result = schema.parse(undefined);
    expect(result).toBe("origin");
  });
});

describe("WorkflowConfig", () => {
  it("validates minimal workflow", () => {
    const workflow = {
      name: "default",
      gates: [
        {
          id: "implement",
          role: "backend",
        },
      ],
    };

    const result = WorkflowConfig.safeParse(workflow);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rejectionStrategy).toBe("origin");
    }
  });

  it("validates complete workflow", () => {
    const workflow = {
      name: "sdlc",
      rejectionStrategy: "origin",
      gates: [
        {
          id: "implement",
          role: "backend",
          description: "Write code",
        },
        {
          id: "review",
          role: "architect",
          canReject: true,
        },
      ],
      outcomes: {
        complete: "advance",
        needs_review: "reject",
      },
    };

    const result = WorkflowConfig.safeParse(workflow);
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const workflow = {
      name: "",
      gates: [{ id: "test", role: "qa" }],
    };

    const result = WorkflowConfig.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it("rejects empty gates array", () => {
    const workflow = {
      name: "test",
      gates: [],
    };

    const result = WorkflowConfig.safeParse(workflow);
    expect(result.success).toBe(false);
  });

  it("accepts optional outcomes", () => {
    const workflow = {
      name: "simple",
      gates: [{ id: "draft", role: "writer" }],
    };

    const result = WorkflowConfig.safeParse(workflow);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outcomes).toBeUndefined();
    }
  });
});

describe("validateWorkflow", () => {
  describe("first gate canReject validation", () => {
    it("rejects first gate with canReject=true", () => {
      const workflow: WorkflowConfig = {
        name: "test",
        rejectionStrategy: "origin",
        gates: [
          {
            id: "implement",
            role: "backend",
            canReject: true, // Invalid: first gate cannot reject
          },
        ],
      };

      const errors = validateWorkflow(workflow);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("First gate cannot have canReject=true");
    });

    it("accepts first gate without canReject", () => {
      const workflow: WorkflowConfig = {
        name: "test",
        rejectionStrategy: "origin",
        gates: [
          {
            id: "implement",
            role: "backend",
          },
        ],
      };

      const errors = validateWorkflow(workflow);
      expect(errors).toHaveLength(0);
    });
  });

  describe("gate ID uniqueness validation", () => {
    it("rejects duplicate gate IDs", () => {
      const workflow: WorkflowConfig = {
        name: "test",
        rejectionStrategy: "origin",
        gates: [
          { id: "test", role: "backend" },
          { id: "review", role: "architect" },
          { id: "test", role: "qa" }, // Duplicate ID
        ],
      };

      const errors = validateWorkflow(workflow);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("Duplicate gate ID: test"))).toBe(
        true
      );
    });

    it("accepts unique gate IDs", () => {
      const workflow: WorkflowConfig = {
        name: "test",
        rejectionStrategy: "origin",
        gates: [
          { id: "implement", role: "backend" },
          { id: "review", role: "architect" },
          { id: "test", role: "qa" },
        ],
      };

      const errors = validateWorkflow(workflow);
      const duplicateErrors = errors.filter((e) => e.includes("Duplicate"));
      expect(duplicateErrors).toHaveLength(0);
    });

    it("allows duplicate gate IDs across separate workflows", () => {
      const workflowA: WorkflowConfig = {
        name: "standard",
        rejectionStrategy: "origin",
        gates: [
          { id: "implement", role: "backend" },
          { id: "review", role: "qa" },
        ],
      };

      const workflowB: WorkflowConfig = {
        name: "fast-track",
        rejectionStrategy: "origin",
        gates: [
          { id: "implement", role: "backend" },
          { id: "review", role: "qa" },
        ],
      };

      expect(validateWorkflow(workflowA)).toEqual([]);
      expect(validateWorkflow(workflowB)).toEqual([]);
    });
  });

  describe("timeout format validation", () => {
    it("accepts valid timeout formats", () => {
      const workflow: WorkflowConfig = {
        name: "test",
        rejectionStrategy: "origin",
        gates: [
          { id: "gate1", role: "backend", timeout: "1h" },
          { id: "gate2", role: "qa", timeout: "30m" },
          { id: "gate3", role: "architect", timeout: "2h" },
        ],
      };

      const errors = validateWorkflow(workflow);
      const timeoutErrors = errors.filter((e) => e.includes("timeout"));
      expect(timeoutErrors).toHaveLength(0);
    });

    it("rejects invalid timeout format", () => {
      const workflow: WorkflowConfig = {
        name: "test",
        rejectionStrategy: "origin",
        gates: [
          { id: "test", role: "backend", timeout: "invalid" },
        ],
      };

      const errors = validateWorkflow(workflow);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("Invalid timeout format"))).toBe(
        true
      );
    });

    it("rejects timeout without unit", () => {
      const workflow: WorkflowConfig = {
        name: "test",
        rejectionStrategy: "origin",
        gates: [
          { id: "test", role: "backend", timeout: "120" },
        ],
      };

      const errors = validateWorkflow(workflow);
      expect(errors.some((e) => e.includes("Invalid timeout format"))).toBe(
        true
      );
    });
  });

  describe("escalateTo validation", () => {
    it("rejects empty escalateTo", () => {
      // Note: WorkflowConfig schema accepts this (Gate allows optional string),
      // but validateWorkflow should catch it
      const workflow = {
        name: "test",
        rejectionStrategy: "origin" as const,
        gates: [
          { id: "test", role: "backend", escalateTo: "" },
        ],
      };

      const parsed = WorkflowConfig.parse(workflow);
      const errors = validateWorkflow(parsed);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("empty escalateTo"))).toBe(true);
    });

    it("rejects whitespace-only escalateTo", () => {
      const workflow: WorkflowConfig = {
        name: "test",
        rejectionStrategy: "origin",
        gates: [
          { id: "test", role: "backend", escalateTo: "   " },
        ],
      };

      const errors = validateWorkflow(workflow);
      expect(errors.some((e) => e.includes("empty escalateTo"))).toBe(true);
    });

    it("accepts valid escalateTo", () => {
      const workflow: WorkflowConfig = {
        name: "test",
        rejectionStrategy: "origin",
        gates: [
          { id: "test", role: "backend", escalateTo: "tech-lead" },
        ],
      };

      const errors = validateWorkflow(workflow);
      const escalateErrors = errors.filter((e) => e.includes("escalateTo"));
      expect(escalateErrors).toHaveLength(0);
    });
  });

  describe("complex workflow validation", () => {
    it("validates multi-gate workflow with all features", () => {
      const workflow: WorkflowConfig = {
        name: "complete",
        rejectionStrategy: "origin",
        gates: [
          {
            id: "implement",
            role: "backend",
            timeout: "2h",
            escalateTo: "architect",
          },
          {
            id: "review",
            role: "architect",
            canReject: true,
            timeout: "1h",
          },
          {
            id: "test",
            role: "qa",
            canReject: true,
          },
        ],
        outcomes: {
          complete: "advance",
          needs_review: "reject",
        },
      };

      const errors = validateWorkflow(workflow);
      expect(errors).toHaveLength(0);
    });
  });
});
