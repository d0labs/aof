/**
 * SLA (Service Level Agreement) configuration and resolution logic.
 * 
 * Defines default time limits for tasks and validation rules.
 * Phase 1: Advisory mode only (alert on violation, no blocking).
 */

import type { TaskFrontmatter } from "../schemas/task.js";
import type { ProjectManifest } from "../schemas/project.js";

/** SLA configuration defaults */
export const DEFAULT_SLA_CONFIG = {
  defaultMaxInProgressMs: 3600000,      // 1 hour
  researchMaxInProgressMs: 14400000,    // 4 hours
  onViolation: "alert" as const,
  alerting: {
    rateLimitMinutes: 15,
  },
};

/** Validation error type */
export interface ValidationError {
  field: string;
  message: string;
}

/** SLA field type from task schema */
type SLAField = NonNullable<TaskFrontmatter["sla"]>;

/**
 * Validate SLA configuration.
 * 
 * @param sla - SLA configuration from task frontmatter
 * @returns Array of validation errors (empty if valid)
 */
export function validateSLA(sla: SLAField | undefined): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!sla) {
    return errors;
  }

  // Validate maxInProgressMs range
  if (sla.maxInProgressMs !== undefined) {
    if (sla.maxInProgressMs < 60000) {
      errors.push({
        field: "sla.maxInProgressMs",
        message: "Minimum 1 minute (60000ms)",
      });
    }
    if (sla.maxInProgressMs > 86400000) {
      errors.push({
        field: "sla.maxInProgressMs",
        message: "Maximum 24 hours (86400000ms)",
      });
    }
  }

  // Validate onViolation enum
  if (sla.onViolation !== undefined) {
    const valid = ["alert", "block", "deadletter"];
    if (!valid.includes(sla.onViolation)) {
      errors.push({
        field: "sla.onViolation",
        message: `Must be one of: ${valid.join(", ")}`,
      });
    }

    // Phase 1 constraint: only 'alert' is supported
    if (sla.onViolation !== "alert") {
      errors.push({
        field: "sla.onViolation",
        message: 'Phase 1: only "alert" is supported',
      });
    }
  }

  return errors;
}

/**
 * Get the effective SLA limit for a task.
 * 
 * Priority: per-task override > per-agent (research) > per-project default > hardcoded default
 * 
 * @param task - Task with optional SLA override
 * @param project - Project configuration with SLA defaults
 * @returns Effective SLA limit in milliseconds
 */
export function getSLALimit(
  task: Pick<TaskFrontmatter, "sla" | "routing">,
  project: Pick<ProjectManifest, "sla">
): number {
  // 1. Per-task override (highest priority)
  if (task.sla?.maxInProgressMs !== undefined) {
    return task.sla.maxInProgressMs;
  }

  // 2. Per-agent research SLA (if agent matches research role)
  if (task.routing?.agent === "swe-researcher") {
    return (
      project.sla?.researchMaxInProgressMs ??
      DEFAULT_SLA_CONFIG.researchMaxInProgressMs
    );
  }

  // 3. Project default
  return (
    project.sla?.defaultMaxInProgressMs ??
    DEFAULT_SLA_CONFIG.defaultMaxInProgressMs
  );
}
