/**
 * Unit tests for gate conditional evaluator.
 * Tests safe expression evaluation with sandboxing and timeout protection.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildGateContext,
  evaluateGateCondition,
  validateGateCondition,
  type GateEvaluationContext,
} from "../gate-conditional.js";
import type { Task } from "../../schemas/task.js";
import type { GateHistoryEntry } from "../../schemas/gate.js";

describe("gate-conditional", () => {
  describe("buildGateContext", () => {
    it("should extract tags, metadata, and gateHistory from task", () => {
      const task: Task = {
        frontmatter: {
          schemaVersion: 1,
          id: "TASK-2026-02-16-001",
          project: "test",
          title: "Test Task",
          status: "in-progress",
          priority: "normal",
          routing: {
            tags: ["security", "api"],
          },
          metadata: {
            dealSize: 100000,
            customer: "acme-corp",
          },
          gateHistory: [
            {
              gate: "dev",
              role: "swe-backend",
              entered: "2026-02-16T10:00:00Z",
              exited: "2026-02-16T11:00:00Z",
              outcome: "complete",
              blockers: [],
            },
          ],
          createdAt: "2026-02-16T10:00:00Z",
          updatedAt: "2026-02-16T11:00:00Z",
          lastTransitionAt: "2026-02-16T11:00:00Z",
          createdBy: "test-agent",
        },
        body: "Test task body",
      };

      const context = buildGateContext(task);

      expect(context.tags).toEqual(["security", "api"]);
      expect(context.metadata).toEqual({
        dealSize: 100000,
        customer: "acme-corp",
      });
      expect(context.gateHistory).toHaveLength(1);
      expect(context.gateHistory[0]?.gate).toBe("dev");
    });

    it("should handle missing optional fields with defaults", () => {
      const task: Task = {
        frontmatter: {
          schemaVersion: 1,
          id: "TASK-2026-02-16-002",
          project: "test",
          title: "Minimal Task",
          status: "backlog",
          priority: "normal",
          routing: {},
          createdAt: "2026-02-16T10:00:00Z",
          updatedAt: "2026-02-16T10:00:00Z",
          lastTransitionAt: "2026-02-16T10:00:00Z",
          createdBy: "test-agent",
        },
        body: "Test task body",
      };

      const context = buildGateContext(task);

      expect(context.tags).toEqual([]);
      expect(context.metadata).toEqual({});
      expect(context.gateHistory).toEqual([]);
    });
  });

  describe("evaluateGateCondition", () => {
    let context: GateEvaluationContext;

    beforeEach(() => {
      context = {
        tags: ["security", "api", "high-priority"],
        metadata: {
          dealSize: 75000,
          customer: "acme-corp",
          requiresApproval: true,
        },
        gateHistory: [
          {
            gate: "dev",
            role: "swe-backend",
            entered: "2026-02-16T10:00:00Z",
            exited: "2026-02-16T11:00:00Z",
            outcome: "complete",
            blockers: [],
          },
        ],
      };
    });

    it("should return true for empty expression (always active)", () => {
      expect(evaluateGateCondition("", context)).toBe(true);
      expect(evaluateGateCondition("   ", context)).toBe(true);
    });

    it("should evaluate tag inclusion correctly", () => {
      expect(evaluateGateCondition("tags.includes('security')", context)).toBe(true);
      expect(evaluateGateCondition("tags.includes('performance')", context)).toBe(false);
    });

    it("should evaluate metadata comparisons correctly", () => {
      expect(evaluateGateCondition("metadata.dealSize > 50000", context)).toBe(true);
      expect(evaluateGateCondition("metadata.dealSize < 50000", context)).toBe(false);
      expect(evaluateGateCondition("metadata.requiresApproval === true", context)).toBe(true);
    });

    it("should handle boolean logic operators", () => {
      expect(
        evaluateGateCondition(
          "tags.includes('security') && metadata.dealSize > 50000",
          context
        )
      ).toBe(true);
      expect(
        evaluateGateCondition(
          "tags.includes('security') || metadata.dealSize > 100000",
          context
        )
      ).toBe(true);
      expect(
        evaluateGateCondition(
          "!tags.includes('performance')",
          context
        )
      ).toBe(true);
    });

    it("should handle array methods (filter, map, some, every)", () => {
      expect(
        evaluateGateCondition(
          "tags.filter(t => t.startsWith('sec')).length > 0",
          context
        )
      ).toBe(true);
      expect(
        evaluateGateCondition(
          "tags.some(t => t === 'api')",
          context
        )
      ).toBe(true);
      expect(
        evaluateGateCondition(
          "tags.every(t => t.length > 0)",
          context
        )
      ).toBe(true);
    });

    it("should handle gateHistory queries", () => {
      expect(
        evaluateGateCondition(
          "gateHistory.length > 0",
          context
        )
      ).toBe(true);
      expect(
        evaluateGateCondition(
          "gateHistory.some(g => g.gate === 'dev')",
          context
        )
      ).toBe(true);
      expect(
        evaluateGateCondition(
          "gateHistory.some(g => g.outcome === 'blocked')",
          context
        )
      ).toBe(false);
    });

    it("should return false for invalid syntax", () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // ODD: return value false is the observable signal for invalid expressions
      expect(evaluateGateCondition("tags.includes(", context)).toBe(false);
      expect(evaluateGateCondition("invalid javascript {{{", context)).toBe(false);
      expect(evaluateGateCondition("metadata.", context)).toBe(false);

      consoleWarnSpy.mockRestore();
    });

    it("should return false for runtime errors", () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // ODD: return value false is the observable signal for runtime evaluation errors
      expect(evaluateGateCondition("metadata.nonexistent.property", context)).toBe(false);

      consoleWarnSpy.mockRestore();
    });

    it("should coerce results to boolean", () => {
      expect(evaluateGateCondition("1", context)).toBe(true);
      expect(evaluateGateCondition("0", context)).toBe(false);
      expect(evaluateGateCondition("'truthy'", context)).toBe(true);
      expect(evaluateGateCondition("''", context)).toBe(false);
      expect(evaluateGateCondition("null", context)).toBe(false);
      expect(evaluateGateCondition("undefined", context)).toBe(false);
      expect(evaluateGateCondition("[]", context)).toBe(true); // Empty array is truthy
    });

    it("should prevent access to global scope", () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      
      // These should fail because Function constructor doesn't have access to outer scope
      expect(evaluateGateCondition("process.exit()", context)).toBe(false);
      expect(evaluateGateCondition("require('fs')", context)).toBe(false);
      expect(evaluateGateCondition("console.log('test')", context)).toBe(false);
      
      consoleWarnSpy.mockRestore();
    });

    it("should handle complex nested expressions", () => {
      expect(
        evaluateGateCondition(
          "(tags.includes('security') || tags.includes('compliance')) && metadata.dealSize > 50000",
          context
        )
      ).toBe(true);
      
      expect(
        evaluateGateCondition(
          "tags.filter(t => t.includes('api')).length > 0 && !metadata.skipReview",
          context
        )
      ).toBe(true);
    });

    it("should treat prototype pollution attempts as invalid", () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // ODD: return value false is the observable signal; prototype attacks are rejected
      expect(evaluateGateCondition("metadata.__proto__.polluted()", context)).toBe(false);
      expect(evaluateGateCondition("({}).__proto__.polluted()", context)).toBe(false);

      consoleWarnSpy.mockRestore();
    });

    it("should return false when evaluation exceeds timeout", () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const nowSpy = vi.spyOn(Date, "now");

      nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(200);

      // ODD: timeout → return value false is the observable signal
      expect(evaluateGateCondition("true", context)).toBe(false);

      consoleWarnSpy.mockRestore();
      nowSpy.mockRestore();
    });
  });

  describe("validateGateCondition", () => {
    it("should return null for valid expressions", () => {
      expect(validateGateCondition("tags.includes('security')")).toBeNull();
      expect(validateGateCondition("metadata.dealSize > 50000")).toBeNull();
      expect(validateGateCondition("tags.some(t => t.startsWith('api'))")).toBeNull();
      expect(validateGateCondition("")).toBeNull(); // Empty is valid
    });

    it("should return error message for invalid syntax", () => {
      const result1 = validateGateCondition("tags.includes(");
      expect(result1).toContain("Invalid gate condition syntax");
      
      const result2 = validateGateCondition("invalid {{{");
      expect(result2).toContain("Invalid gate condition syntax");
      
      const result3 = validateGateCondition("metadata.");
      expect(result3).toContain("Invalid gate condition syntax");
    });

    it("should validate without executing side effects", () => {
      // This should parse but not execute
      const result = validateGateCondition("console.log('test')");
      expect(result).toBeNull(); // Valid syntax, even though it would fail at runtime
    });
  });
});
