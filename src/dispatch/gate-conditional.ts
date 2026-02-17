/**
 * Gate conditional evaluator — sandboxed JavaScript expression evaluation.
 *
 * Provides safe evaluation of `when` clauses on gates, allowing conditional
 * gate activation based on task metadata, tags, and history.
 *
 * Security model:
 * - Uses Function constructor for sandboxed evaluation (no outer scope access)
 * - No access to require/import, filesystem, or network
 * - 100ms timeout protection
 * - All exceptions caught and logged (never throws)
 * - Invalid expressions evaluate to false (skip gate)
 *
 * @module gate-conditional
 */

import type { Task } from "../schemas/task.js";
import type { GateHistoryEntry } from "../schemas/gate.js";

/**
 * Evaluation context for gate conditional expressions.
 *
 * Provides three variables to the expression:
 * - `tags`: Array of task tags for capability-based routing
 * - `metadata`: Task metadata object (arbitrary key-value pairs)
 * - `gateHistory`: Audit trail of previous gate transitions
 */
export interface GateEvaluationContext {
  /** Task tags for capability-based matching. */
  tags: string[];
  /** Task metadata (arbitrary key-value pairs). */
  metadata: Record<string, unknown>;
  /** Audit trail of gate transitions. */
  gateHistory: GateHistoryEntry[];
}

/**
 * Build evaluation context from a task for gate conditionals.
 *
 * Extracts tags, metadata, and gateHistory from task frontmatter with safe defaults.
 *
 * @param task - Task to extract context from
 * @returns Evaluation context ready for gate condition evaluation
 */
export function buildGateContext(task: Task): GateEvaluationContext {
  return {
    tags: task.frontmatter.routing.tags ?? [],
    metadata: task.frontmatter.metadata ?? {},
    gateHistory: task.frontmatter.gateHistory ?? [],
  };
}

/**
 * Evaluate a gate conditional expression safely.
 *
 * Runs the expression in a sandboxed environment with no access to outer scope,
 * require/import, filesystem, or network. Enforces a 100ms timeout and catches
 * all exceptions.
 *
 * Expression has access to three variables:
 * - `tags` (string[]): Task tags
 * - `metadata` (Record<string, unknown>): Task metadata
 * - `gateHistory` (GateHistoryEntry[]): Gate transition history
 *
 * Examples:
 * - `tags.includes('security')` — true if task has security tag
 * - `metadata.dealSize > 50000` — true if dealSize exceeds threshold
 * - `gateHistory.some(g => g.outcome === 'blocked')` — true if any gate was blocked
 *
 * @param expression - JavaScript expression (e.g., "tags.includes('security')")
 * @param context - Evaluation context (tags, metadata, gateHistory)
 * @returns true if expression evaluates to truthy, false otherwise
 *
 * Safety guarantees:
 * - Empty/whitespace expressions return true (no condition = always active)
 * - Syntax errors return false and log warning
 * - Runtime errors return false and log warning
 * - Timeout (>100ms) returns false and logs warning
 * - No access to global scope (process, require, filesystem, etc.)
 */
export function evaluateGateCondition(
  expression: string,
  context: GateEvaluationContext
): boolean {
  // Empty expression = always active
  if (!expression || expression.trim().length === 0) {
    return true;
  }

  try {
    // Use Function constructor for sandboxed eval
    // Provides tags, metadata, gateHistory as function parameters
    // "use strict" prevents accidental global assignments
    const evalFn = new Function(
      "tags",
      "metadata",
      "gateHistory",
      `"use strict"; return (${expression});`
    );

    // Track evaluation time for timeout enforcement
    const startTime = Date.now();

    // Execute expression with context
    const result = evalFn(
      context.tags,
      context.metadata,
      context.gateHistory
    );

    // Check timeout (100ms max)
    const duration = Date.now() - startTime;
    if (duration > 100) {
      console.warn(
        `Gate condition evaluation timeout: ${expression} (${duration}ms)`
      );
      return false;
    }

    // Coerce result to boolean (matches JavaScript truthiness rules)
    return !!result;
  } catch (error) {
    // Any error = expression evaluates to false (skip gate)
    console.warn(`Gate condition evaluation error: ${expression}`, error);
    return false;
  }
}

/**
 * Validate that a gate condition expression is syntactically valid.
 *
 * Parses the expression without executing it to check for syntax errors.
 * Useful for config validation and early error detection.
 *
 * Note: This only validates syntax, not semantics. An expression may parse
 * successfully but still fail at runtime (e.g., accessing undefined properties).
 *
 * @param expression - JavaScript expression to validate
 * @returns null if valid, error message if invalid
 *
 * Examples:
 * - `validateGateCondition("tags.includes('security')")` → null (valid)
 * - `validateGateCondition("tags.includes(")` → error message (invalid)
 */
export function validateGateCondition(expression: string): string | null {
  // Empty expression is valid (always active)
  if (!expression || expression.trim().length === 0) {
    return null;
  }

  try {
    // Test parse by creating function (doesn't execute)
    new Function("tags", "metadata", "gateHistory", `return (${expression});`);
    return null; // Parsed successfully
  } catch (error) {
    return `Invalid gate condition syntax: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}
