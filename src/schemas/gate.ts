/**
 * Workflow Gates schema — core type definitions for gate-based task progression.
 *
 * Gates represent checkpoints in a workflow where specific roles (agents or humans)
 * must review, validate, or approve work before the task can proceed.
 *
 * These are pure type definitions with no logic — the foundation for gate evaluation
 * and workflow orchestration.
 */

import { z } from "zod";

/**
 * Gate outcome — the result of passing through a gate.
 *
 * - `complete`: Gate passed successfully, task can proceed to next gate
 * - `needs_review`: Gate requires additional review (human intervention or escalation)
 * - `blocked`: Gate failed, task cannot proceed (e.g., tests failed, approval rejected)
 */
export const GateOutcome = z.enum(["complete", "needs_review", "blocked"]);
export type GateOutcome = z.infer<typeof GateOutcome>;

/**
 * Gate definition — a checkpoint in the workflow.
 *
 * Each gate is owned by a specific role and may have conditional logic,
 * timeout constraints, and escalation rules.
 */
export const Gate = z.object({
  /** Unique gate identifier within the workflow (e.g., "dev", "qa", "deploy"). */
  id: z.string().min(1),
  /** Role responsible for this gate (from org chart, e.g., "swe-backend", "swe-qa"). */
  role: z.string().min(1),
  /** Whether this gate can reject the task (send back to previous gate). */
  canReject: z.boolean().default(false),
  /** Optional condition expression for gate activation (e.g., "status === 'review'"). */
  when: z.string().optional(),
  /** Human-readable description of gate purpose and acceptance criteria. */
  description: z.string().optional(),
  /** Whether this gate requires human approval (blocks agent-only execution). */
  requireHuman: z.boolean().optional(),
  /** Maximum time allowed at this gate before escalation (e.g., "1h", "30m", "2h"). */
  timeout: z.string().optional(),
  /** Role or agent to escalate to if timeout is exceeded. */
  escalateTo: z.string().optional(),
});
export type Gate = z.infer<typeof Gate>;

/**
 * Gate history entry — audit trail record for a task passing through a gate.
 *
 * Captured when a task enters and exits a gate, with outcome and any blockers.
 * Used for analytics, SLA tracking, and debugging workflow bottlenecks.
 */
export const GateHistoryEntry = z.object({
  /** Gate ID that was entered. */
  gate: z.string(),
  /** Role that processed this gate. */
  role: z.string(),
  /** Specific agent that processed the gate (optional, may be system or human). */
  agent: z.string().optional(),
  /** ISO-8601 timestamp when task entered this gate. */
  entered: z.string().datetime(),
  /** ISO-8601 timestamp when task exited this gate (absent if still in gate). */
  exited: z.string().datetime().optional(),
  /** Outcome when exiting the gate (absent if still in gate). */
  outcome: GateOutcome.optional(),
  /** Brief summary of gate processing (e.g., "All tests passed", "Approved by PM"). */
  summary: z.string().optional(),
  /** List of blockers encountered at this gate (e.g., test failures, missing docs). */
  blockers: z.array(z.string()).default([]),
  /** Rejection notes if gate outcome was 'blocked' or task was sent back. */
  rejectionNotes: z.string().optional(),
  /** Time spent in this gate in seconds (computed: exited - entered). */
  duration: z.number().int().nonnegative().optional(),
});
export type GateHistoryEntry = z.infer<typeof GateHistoryEntry>;

/**
 * Review context — feedback from a previous gate rejection.
 *
 * When a gate rejects a task, this context is passed back to the previous gate
 * so the agent knows what needs to be fixed before resubmission.
 */
export const ReviewContext = z.object({
  /** Gate that rejected the task (e.g., "qa", "security"). */
  fromGate: z.string(),
  /** Agent that performed the rejection (optional, may be human). */
  fromAgent: z.string().optional(),
  /** Role that rejected the task. */
  fromRole: z.string(),
  /** ISO-8601 timestamp of rejection. */
  timestamp: z.string().datetime(),
  /** List of specific issues that blocked progression. */
  blockers: z.array(z.string()).default([]),
  /** Freeform notes explaining what needs to be fixed. */
  notes: z.string().optional(),
});
export type ReviewContext = z.infer<typeof ReviewContext>;

/**
 * Gate transition — the result of evaluating a gate.
 *
 * Emitted when a task moves from one gate to another, capturing the outcome,
 * agent involvement, duration, and any gates that were skipped due to conditionals.
 */
export const GateTransition = z.object({
  /** Task ID that transitioned (e.g., "TASK-2026-02-16-001"). */
  taskId: z.string(),
  /** Gate the task is leaving (absent if entering first gate). */
  fromGate: z.string().optional(),
  /** Gate the task is entering (absent if exiting final gate). */
  toGate: z.string().optional(),
  /** Outcome of the transition. */
  outcome: GateOutcome,
  /** Agent that triggered the transition (optional, may be system-driven). */
  agent: z.string().optional(),
  /** ISO-8601 timestamp of the transition. */
  timestamp: z.string().datetime(),
  /** Time spent in the previous gate in seconds (if applicable). */
  duration: z.number().int().nonnegative().optional(),
  /** List of gate IDs that were skipped due to conditional logic. */
  skipped: z.array(z.string()).default([]),
});
export type GateTransition = z.infer<typeof GateTransition>;

/**
 * Test specification — BDD-style test case for gate validation.
 *
 * Used to define automated tests for gate behavior in a human-readable format.
 * Follows Given-When-Then structure for clarity.
 */
export const TestSpec = z.object({
  /** Given clause: preconditions or initial state (e.g., "a user is logged in"). */
  given: z.string(),
  /** When clause: action or event (e.g., "they submit a valid form"). */
  when: z.string(),
  /** Then clause: expected outcome (status code, response body patterns). */
  then: z.object({
    /** Expected HTTP status code (optional). */
    status: z.number().int().optional(),
    /** Substrings expected in response body (optional). */
    body_contains: z.array(z.string()).optional(),
  }),
});
export type TestSpec = z.infer<typeof TestSpec>;
