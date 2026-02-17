/**
 * Workflow configuration schema for project.yaml
 *
 * Defines multi-stage workflows with gates, rejection strategies, and validation.
 * See ~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md for complete spec.
 */

import { z } from "zod";
import { Gate } from "./gate.js";

/**
 * Rejection strategy — how far to loop back on rejection.
 *
 * V1 only supports "origin" (all rejections return to first gate).
 * Future versions may add "previous" (loop to prior gate) or "named" (loop to specific gate).
 */
export const RejectionStrategy = z.enum(["origin"]);
export type RejectionStrategy = z.infer<typeof RejectionStrategy>;

/**
 * Workflow configuration — defines multi-stage task progression.
 *
 * A workflow specifies:
 * - Ordered sequence of gates (checkpoints)
 * - Rejection strategy (where rejected tasks loop back)
 * - Optional outcome descriptions (semantic labels for gate results)
 *
 * @example
 * ```yaml
 * workflow:
 *   name: default
 *   rejectionStrategy: origin
 *   gates:
 *     - id: implement
 *       role: backend
 *     - id: review
 *       role: architect
 *       canReject: true
 *   outcomes:
 *     complete: advance
 *     needs_review: reject
 * ```
 */
export const WorkflowConfig = z.object({
  /** Workflow name (unique within project). */
  name: z.string().min(1),
  /** Rejection loop-back strategy (v1: only "origin" supported). */
  rejectionStrategy: RejectionStrategy.default("origin"),
  /** Ordered sequence of gates (at least one required). */
  gates: z.array(Gate).min(1),
  /** Optional outcome descriptions (helps agents understand semantics). */
  outcomes: z.record(z.string(), z.string()).optional(),
});
export type WorkflowConfig = z.infer<typeof WorkflowConfig>;

/**
 * Validate workflow configuration for internal consistency.
 *
 * Checks:
 * - First gate cannot have canReject=true (nowhere to loop back to)
 * - Gate IDs must be unique within workflow
 * - Timeout must be valid duration format (e.g., "1h", "30m")
 * - escalateTo must not be empty if specified
 *
 * @param workflow - Workflow config to validate
 * @returns Array of validation errors (empty if valid)
 *
 * @example
 * ```typescript
 * const workflow = { name: "test", gates: [...] };
 * const errors = validateWorkflow(workflow);
 * if (errors.length > 0) {
 *   console.error("Validation errors:", errors);
 * }
 * ```
 */
export function validateWorkflow(workflow: WorkflowConfig): string[] {
  const errors: string[] = [];

  // First gate cannot reject (nowhere to loop back to)
  if (workflow.gates.length > 0 && workflow.gates[0]?.canReject) {
    errors.push(
      "First gate cannot have canReject=true (no previous gate to return to)"
    );
  }

  // Gate IDs must be unique
  const gateIds = new Set<string>();
  for (const gate of workflow.gates) {
    if (gateIds.has(gate.id)) {
      errors.push(`Duplicate gate ID: ${gate.id}`);
    }
    gateIds.add(gate.id);
  }

  // Timeout must be valid duration format (e.g., "1h", "30m")
  const durationRegex = /^\d+[mh]$/;
  for (const gate of workflow.gates) {
    if (gate.timeout && !durationRegex.test(gate.timeout)) {
      errors.push(
        `Invalid timeout format for gate ${gate.id}: ${gate.timeout} (expected: "1h", "30m", etc.)`
      );
    }
  }

  // If gate has escalateTo, it must reference a role (can't validate against org chart here)
  for (const gate of workflow.gates) {
    if (gate.escalateTo !== undefined && gate.escalateTo.trim().length === 0) {
      errors.push(`Gate ${gate.id} has empty escalateTo role`);
    }
  }

  return errors;
}
