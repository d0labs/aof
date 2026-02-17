/**
 * Gate Context Builder — Progressive disclosure for task payloads.
 *
 * When AOF dispatches a task to an agent, inject gate-specific context that
 * explains what's expected at this gate, what outcomes mean, and practical tips.
 *
 * This is Progressive Disclosure Level 2 (Design Doc §4.2):
 * The task itself teaches the agent what's expected at this gate.
 */

import type { Gate, GateOutcome } from "../schemas/gate.js";
import type { Task } from "../schemas/task.js";
import type { WorkflowConfig } from "../schemas/workflow.js";

/**
 * Gate context — injected into task payload when dispatching.
 *
 * This provides progressive disclosure: agents see only what's relevant to
 * their current gate, with clear expectations and outcome explanations.
 */
export interface GateContext {
  /** Plain-language role explanation (e.g., "You are reviewing this code for quality"). */
  role: string;
  /** Current gate ID (e.g., "code-review"). */
  gate: string;
  /** Checklist of expectations for this gate. */
  expectations: string[];
  /** What each outcome means (plain language, no jargon). */
  outcomes: Record<GateOutcome, string>;
  /** Optional practical guidance and tips. */
  tips?: string[];
}

/**
 * Build gate context for a task at a specific gate.
 *
 * Progressive disclosure: only show what's relevant to THIS gate.
 *
 * @param task - Task being dispatched
 * @param gate - Current gate the task is at
 * @param workflow - Workflow configuration
 * @returns Gate context for injection into task payload
 */
export function buildGateContext(
  task: Task,
  gate: Gate,
  workflow: WorkflowConfig
): GateContext {
  const context: GateContext = {
    role: buildRoleDescription(gate, task),
    gate: gate.id,
    expectations: buildExpectations(gate, task),
    outcomes: buildOutcomeDescriptions(gate, workflow),
  };

  const tips = buildTips(gate, task);
  if (tips && tips.length > 0) {
    context.tips = tips;
  }

  return context;
}

/**
 * Build plain-language role description for the agent.
 *
 * Adapts based on:
 * - Whether this is a rejection loop-back
 * - Whether the gate can reject (review vs implementation)
 * - Whether human approval is required
 *
 * @param gate - Current gate
 * @param task - Task being dispatched
 * @returns Plain-language role description
 */
function buildRoleDescription(gate: Gate, task: Task): string {
  const workType = getWorkType(task);
  const reviewContext = task.frontmatter.reviewContext;

  // Check if this is a rejection loop-back
  if (reviewContext && reviewContext.fromGate !== gate.id) {
    return `You are fixing issues from a previous review.`;
  }

  // Review gate (canReject = true)
  if (gate.canReject) {
    return `You are reviewing this ${workType} for quality and compliance.`;
  }

  // Approval gate (requireHuman = true)
  if (gate.requireHuman) {
    return `You are providing final approval for this ${workType}.`;
  }

  // Implementation gate (default)
  if (gate.description) {
    return `You are working on the ${gate.id} stage: ${gate.description}`;
  }

  return `You are working on the ${gate.id} stage.`;
}

/**
 * Detect work type from task tags for contextual role descriptions.
 *
 * @param task - Task being dispatched
 * @returns Human-readable work type
 */
function getWorkType(task: Task): string {
  const tags = task.frontmatter.routing.tags ?? [];

  if (tags.includes("feature")) return "feature";
  if (tags.includes("bug")) return "bug fix";
  if (tags.includes("docs")) return "documentation";

  return "work";
}

/**
 * Build expectations checklist for this gate.
 *
 * Adapts based on:
 * - Whether this is a rejection loop (focus on blockers)
 * - Whether the gate can reject (review vs implementation)
 * - Gate description from workflow config
 *
 * @param gate - Current gate
 * @param task - Task being dispatched
 * @returns List of expectations
 */
function buildExpectations(gate: Gate, task: Task): string[] {
  const expectations: string[] = [];
  const reviewContext = task.frontmatter.reviewContext;

  // If looped back from review, expectations focus on fixes
  if (reviewContext) {
    expectations.push("Address ALL blockers listed in reviewContext below");
    expectations.push("Don't introduce new issues while fixing");
    expectations.push("Re-run tests and coverage checks");
    return expectations;
  }

  // Standard expectations by gate characteristics
  if (gate.canReject) {
    // Review gate
    expectations.push("Review for quality and correctness");
    expectations.push("Check for security issues");
    expectations.push("Verify all requirements are met");
    if (gate.description) {
      expectations.push(gate.description);
    }
  } else if (gate.requireHuman) {
    // Approval gate
    expectations.push("Verify deliverables meet acceptance criteria");
    expectations.push("Confirm no blocking issues remain");
  } else {
    // Implementation gate
    expectations.push("Complete the work described in the task");
    if (gate.description) {
      expectations.push(gate.description);
    }
  }

  return expectations;
}

/**
 * Build plain-language descriptions for each gate outcome.
 *
 * Explains what happens when the agent completes the gate with each outcome.
 *
 * @param gate - Current gate
 * @param workflow - Workflow configuration
 * @returns Outcome descriptions
 */
function buildOutcomeDescriptions(
  gate: Gate,
  workflow: WorkflowConfig
): Record<GateOutcome, string> {
  const outcomes: Record<GateOutcome, string> = {
    complete: "Work is done and ready to advance to the next stage",
    needs_review: "Work needs revision - list specific issues to fix",
    blocked: "Cannot proceed - external dependency or blocker",
  };

  // Customize based on gate position
  const gateIndex = workflow.gates.findIndex((g) => g.id === gate.id);
  const isLastGate = gateIndex === workflow.gates.length - 1;

  if (isLastGate) {
    outcomes.complete = "Work is complete - task will be marked done";
  } else if (gateIndex >= 0 && gateIndex < workflow.gates.length - 1) {
    const nextGate = workflow.gates[gateIndex + 1];
    outcomes.complete = `Work is done - it will advance to ${nextGate!.id}`;
  }

  if (gate.canReject) {
    outcomes.needs_review = "Work needs fixes - it will go back to the implementer";
  } else {
    outcomes.needs_review = "Not applicable for this gate";
  }

  return outcomes;
}

/**
 * Build practical tips for the agent.
 *
 * Provides contextual guidance based on gate type and review context.
 *
 * @param gate - Current gate
 * @param task - Task being dispatched
 * @returns Optional list of tips
 */
function buildTips(gate: Gate, task: Task): string[] | undefined {
  const tips: string[] = [];

  // Tips for review gates
  if (gate.canReject) {
    tips.push("Be specific in blockers - vague feedback wastes time");
    tips.push("One blocker per issue for clarity");
  }

  // Tips when addressing review feedback
  const reviewContext = task.frontmatter.reviewContext;
  if (reviewContext && reviewContext.blockers.length > 0) {
    tips.push(
      `Review feedback: ${reviewContext.blockers.length} issues to address`
    );
  }

  return tips.length > 0 ? tips : undefined;
}
