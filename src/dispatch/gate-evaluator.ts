/**
 * Gate evaluation algorithm — deterministic state machine for task progression.
 *
 * Core logic that decides what happens when a task completes at a gate:
 * - Complete: advance to next gate (skip conditionals), or mark done if no more gates
 * - Needs review: loop back to first gate with reviewContext
 * - Blocked: stay in current gate, log blockers
 *
 * This is a pure function with no I/O — takes task, workflow, and outcome,
 * returns GateTransition and task updates. Makes it easy to test and reason about.
 *
 * @module gate-evaluator
 */

import type { Task } from "../schemas/task.js";
import type { WorkflowConfig } from "../schemas/workflow.js";
import type { GateOutcome, GateTransition, GateHistoryEntry } from "../schemas/gate.js";
import { evaluateGateCondition, buildGateContext } from "./gate-conditional.js";

/**
 * Input for gate evaluation — everything needed to determine next gate.
 *
 * Includes current task state, workflow config, agent outcome, and completion context.
 */
export interface GateEvaluationInput {
  /** Task being evaluated (with current gate state). */
  task: Task;
  /** Workflow configuration (gate sequence and rules). */
  workflow: WorkflowConfig;
  /** Agent's outcome at this gate (complete/needs_review/blocked). */
  outcome: GateOutcome;
  /** Brief summary of gate processing (e.g., "All tests passed"). */
  summary: string;
  /** List of blockers encountered (for blocked/needs_review outcomes). */
  blockers?: string[];
  /** Rejection notes explaining what needs to be fixed (for needs_review). */
  rejectionNotes?: string;
  /** Agent ID that processed this gate. */
  agent?: string;
}

/**
 * Result of gate evaluation — transition and task updates.
 *
 * Contains everything needed to update task state and emit telemetry.
 */
export interface GateEvaluationResult {
  /** Gate transition record (for telemetry and history). */
  transition: GateTransition;
  /** Task frontmatter updates to apply. */
  taskUpdates: {
    /** New gate state (current gate and entry timestamp). */
    gate?: { current: string; entered: string };
    /** New routing info (role and workflow). */
    routing?: { role: string; workflow: string };
    /** Updated gate history (append new entry). */
    gateHistory: GateHistoryEntry[];
    /** Review context from rejection (set on needs_review, cleared on advance). */
    reviewContext?: {
      fromGate: string;
      fromAgent?: string;
      fromRole: string;
      timestamp: string;
      blockers: string[];
      notes: string;
    };
    /** Task status update (set to "done" when no more gates, "blocked" on block). */
    status?: string;
  };
  /** List of gate IDs that were skipped due to conditional logic. */
  skippedGates: string[];
}

/**
 * Evaluate gate progression for a task completion.
 * Pure function - no I/O, deterministic output.
 *
 * Algorithm:
 * 1. Find current gate in workflow
 * 2. Create history entry for current gate completion
 * 3. Route based on outcome:
 *    - complete: find next active gate (skip conditionals), or mark done
 *    - needs_review: loop back to first gate, set reviewContext
 *    - blocked: stay in current gate, set status=blocked
 * 4. Return transition and task updates
 *
 * @param input - Task, workflow, outcome, and completion context
 * @returns Gate transition result with task updates
 * @throws Error if current gate not found in workflow
 */
export function evaluateGateTransition(
  input: GateEvaluationInput
): GateEvaluationResult {
  const { task, workflow, outcome, summary, blockers, rejectionNotes, agent } = input;
  const currentGate = task.frontmatter.gate?.current;
  const timestamp = new Date().toISOString();
  const skippedGates: string[] = [];

  // Find current gate in workflow
  const currentGateIndex = workflow.gates.findIndex((g) => g.id === currentGate);
  if (currentGateIndex === -1) {
    throw new Error(`Current gate ${currentGate} not found in workflow`);
  }

  const currentGateConfig = workflow.gates[currentGateIndex];
  if (!currentGateConfig) {
    throw new Error(`Gate at index ${currentGateIndex} not found in workflow`);
  }

  const entered = task.frontmatter.gate?.entered ?? timestamp;
  const duration = Math.floor((Date.now() - new Date(entered).getTime()) / 1000);

  // Create history entry for current gate completion
  const historyEntry: GateHistoryEntry = {
    gate: currentGate ?? "unknown",
    role: currentGateConfig.role,
    agent,
    entered,
    exited: timestamp,
    outcome,
    summary,
    blockers: blockers ?? [],
    rejectionNotes,
    duration,
  };

  // Handle outcome
  if (outcome === "complete") {
    return handleCompleteOutcome(input, currentGateIndex, historyEntry, skippedGates, timestamp);
  } else if (outcome === "needs_review") {
    return handleRejectionOutcome(input, currentGateIndex, historyEntry, timestamp);
  } else if (outcome === "blocked") {
    return handleBlockedOutcome(input, historyEntry, timestamp);
  }

  throw new Error(`Unknown outcome: ${outcome}`);
}

/**
 * Handle complete outcome: advance to next gate or mark done.
 *
 * Iterates through remaining gates, skipping those with inactive conditionals.
 * If all remaining gates are skipped, task is marked done.
 *
 * @param input - Evaluation input
 * @param currentGateIndex - Index of current gate in workflow
 * @param historyEntry - History entry for current gate
 * @param skippedGates - Accumulator for skipped gate IDs
 * @param timestamp - Current timestamp
 * @returns Evaluation result with next gate or done status
 */
function handleCompleteOutcome(
  input: GateEvaluationInput,
  currentGateIndex: number,
  historyEntry: GateHistoryEntry,
  skippedGates: string[],
  timestamp: string
): GateEvaluationResult {
  const { task, workflow } = input;

  // Find next active gate (skip conditionals)
  let nextGateIndex = currentGateIndex + 1;
  const context = buildGateContext(task);

  while (nextGateIndex < workflow.gates.length) {
    const nextGate = workflow.gates[nextGateIndex];
    if (!nextGate) {
      // This should never happen since we're checking against array length,
      // but TypeScript requires the check
      break;
    }

    // Check if gate is active (conditional evaluation)
    if (nextGate.when) {
      const isActive = evaluateGateCondition(nextGate.when, context);
      if (!isActive) {
        skippedGates.push(nextGate.id);
        nextGateIndex++;
        continue; // Skip this gate
      }
    }

    // Found next active gate
    return {
      transition: {
        taskId: task.frontmatter.id,
        fromGate: historyEntry.gate,
        toGate: nextGate.id,
        outcome: "complete",
        agent: historyEntry.agent,
        timestamp,
        duration: historyEntry.duration,
        skipped: skippedGates,
      },
      taskUpdates: {
        gate: { current: nextGate.id, entered: timestamp },
        routing: { role: nextGate.role, workflow: workflow.name },
        gateHistory: [...(task.frontmatter.gateHistory ?? []), historyEntry],
        reviewContext: undefined, // Clear review context on advance
      },
      skippedGates,
    };
  }

  // No more gates - task is complete
  return {
    transition: {
      taskId: task.frontmatter.id,
      fromGate: historyEntry.gate,
      toGate: undefined,
      outcome: "complete",
      agent: historyEntry.agent,
      timestamp,
      duration: historyEntry.duration,
      skipped: skippedGates,
    },
    taskUpdates: {
      gateHistory: [...(task.frontmatter.gateHistory ?? []), historyEntry],
      status: "done", // Mark task complete
    },
    skippedGates,
  };
}

/**
 * Handle rejection outcome: loop back to first gate with reviewContext.
 *
 * Implements "origin" rejection strategy (all rejections return to first gate).
 * Sets reviewContext so agent knows what to fix.
 *
 * @param input - Evaluation input
 * @param currentGateIndex - Index of current gate in workflow
 * @param historyEntry - History entry for current gate
 * @param timestamp - Current timestamp
 * @returns Evaluation result with loopback to first gate
 */
function handleRejectionOutcome(
  input: GateEvaluationInput,
  currentGateIndex: number,
  historyEntry: GateHistoryEntry,
  timestamp: string
): GateEvaluationResult {
  const { task, workflow, blockers, rejectionNotes } = input;

  // D4: All rejections return to first gate (origin strategy)
  const targetGate = workflow.gates[0];
  if (!targetGate) {
    throw new Error("Workflow has no gates (cannot reject)");
  }

  const currentGateConfig = workflow.gates[currentGateIndex];
  if (!currentGateConfig) {
    throw new Error(`Gate at index ${currentGateIndex} not found in workflow`);
  }

  return {
    transition: {
      taskId: task.frontmatter.id,
      fromGate: historyEntry.gate,
      toGate: targetGate.id,
      outcome: "needs_review",
      agent: historyEntry.agent,
      timestamp,
      duration: historyEntry.duration,
      skipped: [],
    },
    taskUpdates: {
      gate: { current: targetGate.id, entered: timestamp },
      routing: { role: targetGate.role, workflow: workflow.name },
      gateHistory: [...(task.frontmatter.gateHistory ?? []), historyEntry],
      reviewContext: {
        fromGate: historyEntry.gate,
        fromAgent: historyEntry.agent,
        fromRole: currentGateConfig.role,
        timestamp,
        blockers: blockers ?? [],
        notes: rejectionNotes ?? "",
      },
    },
    skippedGates: [],
  };
}

/**
 * Handle blocked outcome: stay in current gate, log blocker.
 *
 * Task remains in current gate with status=blocked.
 * History entry recorded for audit trail.
 *
 * @param input - Evaluation input
 * @param historyEntry - History entry for current gate
 * @param timestamp - Current timestamp
 * @returns Evaluation result with no gate change
 */
function handleBlockedOutcome(
  input: GateEvaluationInput,
  historyEntry: GateHistoryEntry,
  timestamp: string
): GateEvaluationResult {
  const { task } = input;

  // Stay in current gate, append to history
  return {
    transition: {
      taskId: task.frontmatter.id,
      fromGate: historyEntry.gate,
      toGate: historyEntry.gate, // Stay in same gate
      outcome: "blocked",
      agent: historyEntry.agent,
      timestamp,
      duration: historyEntry.duration,
      skipped: [],
    },
    taskUpdates: {
      gateHistory: [...(task.frontmatter.gateHistory ?? []), historyEntry],
      status: "blocked", // Update task status
    },
    skippedGates: [],
  };
}
