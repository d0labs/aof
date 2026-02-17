import { describe, it, expect } from "vitest";
import { TaskFrontmatter } from "../task.js";
import { validateSLA, getSLALimit, DEFAULT_SLA_CONFIG } from "../../config/sla-defaults.js";
import type { ProjectManifest } from "../project.js";

describe("SLA Schema Extension", () => {
  const baseTaskFrontmatter = {
    schemaVersion: 1,
    id: "TASK-2026-02-13-001",
    project: "AOF",
    title: "Test Task",
    status: "backlog",
    priority: "normal",
    routing: {},
    createdAt: "2026-02-13T20:00:00Z",
    updatedAt: "2026-02-13T20:00:00Z",
    lastTransitionAt: "2026-02-13T20:00:00Z",
    createdBy: "swe-backend",
    dependsOn: [],
    metadata: {},
  } as const;

  describe("Task Schema - SLA Field", () => {
    it("accepts task without sla field (backward compat)", () => {
      const result = TaskFrontmatter.safeParse(baseTaskFrontmatter);
      expect(result.success).toBe(true);
    });

    it("accepts task with sla.maxInProgressMs", () => {
      const withSLA = {
        ...baseTaskFrontmatter,
        sla: {
          maxInProgressMs: 3600000, // 1 hour
        },
      };
      const result = TaskFrontmatter.safeParse(withSLA);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sla?.maxInProgressMs).toBe(3600000);
      }
    });

    it("accepts task with sla.onViolation", () => {
      const withSLA = {
        ...baseTaskFrontmatter,
        sla: {
          onViolation: "alert" as const,
        },
      };
      const result = TaskFrontmatter.safeParse(withSLA);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sla?.onViolation).toBe("alert");
      }
    });

    it("accepts task with both SLA fields", () => {
      const withSLA = {
        ...baseTaskFrontmatter,
        sla: {
          maxInProgressMs: 14400000, // 4 hours
          onViolation: "alert" as const,
        },
      };
      const result = TaskFrontmatter.safeParse(withSLA);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sla?.maxInProgressMs).toBe(14400000);
        expect(result.data.sla?.onViolation).toBe("alert");
      }
    });
  });

  describe("SLA Validation", () => {
    it("validates minimum SLA limit (1 minute)", () => {
      const errors = validateSLA({ maxInProgressMs: 30000 }); // 30 seconds
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].field).toBe("sla.maxInProgressMs");
      expect(errors[0].message).toContain("Minimum 1 minute");
    });

    it("validates maximum SLA limit (24 hours)", () => {
      const errors = validateSLA({ maxInProgressMs: 90000000 }); // 25 hours
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].field).toBe("sla.maxInProgressMs");
      expect(errors[0].message).toContain("Maximum 24 hours");
    });

    it("accepts valid SLA limit within range", () => {
      const errors = validateSLA({ maxInProgressMs: 3600000 }); // 1 hour
      expect(errors.length).toBe(0);
    });

    it("validates onViolation must be alert|block|deadletter", () => {
      const errors = validateSLA({ onViolation: "invalid" as any });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].field).toBe("sla.onViolation");
    });

    it("Phase 1 constraint: only 'alert' is supported", () => {
      const errorsBlock = validateSLA({ onViolation: "block" });
      expect(errorsBlock.length).toBeGreaterThan(0);
      expect(errorsBlock[0].message).toContain('Phase 1: only "alert" is supported');

      const errorsDeadletter = validateSLA({ onViolation: "deadletter" });
      expect(errorsDeadletter.length).toBeGreaterThan(0);
      expect(errorsDeadletter[0].message).toContain('Phase 1: only "alert" is supported');
    });

    it("accepts 'alert' violation policy", () => {
      const errors = validateSLA({ onViolation: "alert" });
      expect(errors.length).toBe(0);
    });

    it("returns empty array for undefined SLA", () => {
      const errors = validateSLA(undefined);
      expect(errors.length).toBe(0);
    });
  });

  describe("SLA Resolution Logic", () => {
    const mockProject: Pick<ProjectManifest, "id" | "sla"> = {
      id: "aof",
      sla: {
        defaultMaxInProgressMs: 3600000, // 1 hour
        researchMaxInProgressMs: 14400000, // 4 hours
        onViolation: "alert",
      },
    };

    it("per-task override takes precedence", () => {
      const task = {
        ...baseTaskFrontmatter,
        sla: { maxInProgressMs: 7200000 }, // 2 hours
      };
      const limit = getSLALimit(task as any, mockProject as any);
      expect(limit).toBe(7200000);
    });

    it("research agent gets researchMaxInProgressMs default", () => {
      const task = {
        ...baseTaskFrontmatter,
        routing: { agent: "swe-researcher" },
      };
      const limit = getSLALimit(task as any, mockProject as any);
      expect(limit).toBe(14400000); // 4 hours
    });

    it("normal task gets defaultMaxInProgressMs", () => {
      const task = {
        ...baseTaskFrontmatter,
        routing: { agent: "swe-backend" },
      };
      const limit = getSLALimit(task as any, mockProject as any);
      expect(limit).toBe(3600000); // 1 hour
    });

    it("fallback to hardcoded defaults if no config", () => {
      const task = {
        ...baseTaskFrontmatter,
        routing: { agent: "swe-backend" },
      };
      const limit = getSLALimit(task as any, {} as any);
      expect(limit).toBe(DEFAULT_SLA_CONFIG.defaultMaxInProgressMs);
    });

    it("research agent fallback to hardcoded default", () => {
      const task = {
        ...baseTaskFrontmatter,
        routing: { agent: "swe-researcher" },
      };
      const limit = getSLALimit(task as any, {} as any);
      expect(limit).toBe(DEFAULT_SLA_CONFIG.researchMaxInProgressMs);
    });
  });
});
