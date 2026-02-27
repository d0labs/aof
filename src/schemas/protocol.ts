/**
 * AOF Protocol Schemas — Zod schemas for inter-agent protocol messages.
 *
 * Defines the typed envelope and payload structures used for structured
 * communication between agents: handoff requests/acks, status updates,
 * and completion reports. All payloads enforce size limits per SEC-003.
 */

import { z } from "zod";
import { TaskId, TaskStatus } from "./task.js";

// ── Protocol payload size limits (SEC-003) ────────────────────────────

/** Maximum length for a completion summary reference string. */
export const MAX_SUMMARY_REF_LENGTH = 256;
/** Maximum length for free-form notes fields. */
export const MAX_NOTES_LENGTH = 10_000;
/** Maximum length for a progress description string. */
export const MAX_PROGRESS_LENGTH = 1_000;
/** Maximum length for a rejection or acknowledgment reason. */
export const MAX_REASON_LENGTH = 512;
/** Maximum length for individual items in array fields (blockers, deliverables, etc.). */
export const MAX_ITEM_LENGTH = 256;
/** Maximum number of deliverable entries in a completion report. */
export const MAX_DELIVERABLES_COUNT = 50;
/** Maximum number of blocker entries in a completion report or status update. */
export const MAX_BLOCKERS_COUNT = 20;
/** Maximum number of context reference entries in a handoff request. */
export const MAX_CONTEXT_REFS_COUNT = 50;
/** Maximum number of acceptance criteria in a handoff request. */
export const MAX_ACCEPTANCE_CRITERIA_COUNT = 50;
/** Maximum number of expected output entries in a handoff request. */
export const MAX_EXPECTED_OUTPUTS_COUNT = 50;
/** Maximum number of constraint entries in a handoff request. */
export const MAX_CONSTRAINTS_COUNT = 50;

// ── Message types ─────────────────────────────────────────────────────

/**
 * Enum of valid protocol message types exchanged between agents.
 */
export const ProtocolMessageType = z.enum([
  "handoff.request",
  "handoff.accepted",
  "handoff.rejected",
  "status.update",
  "completion.report",
]);
/** Union type of all valid protocol message type strings. */
export type ProtocolMessageType = z.infer<typeof ProtocolMessageType>;

// ── Completion ────────────────────────────────────────────────────────

/**
 * Outcome of a task completion: done, blocked, needs_review, or partial.
 */
export const CompletionOutcome = z.enum([
  "done",
  "blocked",
  "needs_review",
  "partial",
]);
/** Union type of completion outcome strings. */
export type CompletionOutcome = z.infer<typeof CompletionOutcome>;

/**
 * Test execution summary included in completion reports.
 * Enforces that passed + failed does not exceed total.
 */
export const TestReport = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .refine((d) => d.passed + d.failed <= d.total, {
    message: "passed + failed must not exceed total",
  });
/** Inferred type for a test execution summary. */
export type TestReport = z.infer<typeof TestReport>;

/**
 * Payload for a completion.report message, summarizing the outcome of
 * a task including deliverables, test results, blockers, and notes.
 */
export const CompletionReportPayload = z.object({
  outcome: CompletionOutcome,
  summaryRef: z.string().max(MAX_SUMMARY_REF_LENGTH),
  deliverables: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_DELIVERABLES_COUNT).default([]),
  tests: TestReport,
  blockers: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_BLOCKERS_COUNT).default([]),
  notes: z.string().max(MAX_NOTES_LENGTH),
});
/** Inferred type for a completion report payload. */
export type CompletionReportPayload = z.infer<typeof CompletionReportPayload>;

// ── Status update ─────────────────────────────────────────────────────

/**
 * Payload for a status.update message, allowing agents to report
 * mid-task progress, blocker changes, and work-log notes.
 * At least one of status, progress, blockers, or notes must be provided.
 */
export const StatusUpdatePayload = z
  .object({
    taskId: TaskId,
    agentId: z.string(),
    status: TaskStatus.optional(),
    progress: z.string().max(MAX_PROGRESS_LENGTH).optional(),
    blockers: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_BLOCKERS_COUNT).optional(),
    notes: z.string().max(MAX_NOTES_LENGTH).optional(),
  })
  .refine(
    (payload) =>
      payload.status !== undefined ||
      payload.progress !== undefined ||
      payload.blockers !== undefined ||
      payload.notes !== undefined,
    { message: "Status update must include status, progress, blockers, or notes" },
  );
/** Inferred type for a status update payload. */
export type StatusUpdatePayload = z.infer<typeof StatusUpdatePayload>;

// ── Handoff ───────────────────────────────────────────────────────────

/**
 * Payload for a handoff.request message, used when one agent delegates
 * a task to another agent with acceptance criteria, expected outputs,
 * context references, constraints, and a deadline.
 */
export const HandoffRequestPayload = z.object({
  taskId: TaskId,
  parentTaskId: TaskId,
  fromAgent: z.string(),
  toAgent: z.string(),
  acceptanceCriteria: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_ACCEPTANCE_CRITERIA_COUNT).default([]),
  expectedOutputs: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_EXPECTED_OUTPUTS_COUNT).default([]),
  contextRefs: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_CONTEXT_REFS_COUNT).default([]),
  constraints: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_CONSTRAINTS_COUNT).default([]),
  dueBy: z.string().datetime(),
});
/** Inferred type for a handoff request payload. */
export type HandoffRequestPayload = z.infer<typeof HandoffRequestPayload>;

/**
 * Payload for handoff.accepted and handoff.rejected messages,
 * carrying the acceptance decision and an optional reason.
 */
export const HandoffAckPayload = z.object({
  taskId: TaskId,
  accepted: z.boolean(),
  reason: z.string().max(MAX_REASON_LENGTH).optional(),
});
/** Inferred type for a handoff acknowledgment payload. */
export type HandoffAckPayload = z.infer<typeof HandoffAckPayload>;

// ── Protocol envelope ─────────────────────────────────────────────────

/**
 * Preprocess hook that normalizes snake_case `project_id` to camelCase
 * `projectId` for backward compatibility with older message producers.
 */
const preprocessProjectId = (val: unknown) => {
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("project_id" in obj && !("projectId" in obj)) {
      return { ...obj, projectId: obj.project_id };
    }
  }
  return val;
};

/**
 * Base fields shared by all protocol envelope variants: protocol identifier,
 * version, project scope, task reference, sender/receiver agents, and timestamp.
 */
const ProtocolEnvelopeBase = z.object({
  protocol: z.literal("aof"),
  version: z.literal(1),
  projectId: z.string(),
  taskRelpath: z.string().optional(),
  taskId: TaskId,
  fromAgent: z.string(),
  toAgent: z.string(),
  sentAt: z.string().datetime(),
});

/**
 * The top-level protocol envelope — a discriminated union on the `type` field.
 * Each variant carries a type-specific payload. Preprocesses `project_id` to
 * `projectId` for backward compatibility.
 */
export const ProtocolEnvelope = z.preprocess(
  preprocessProjectId,
  z.discriminatedUnion("type", [
    ProtocolEnvelopeBase.extend({
      type: z.literal("handoff.request"),
      payload: HandoffRequestPayload,
    }),
    ProtocolEnvelopeBase.extend({
      type: z.literal("handoff.accepted"),
      payload: HandoffAckPayload,
    }),
    ProtocolEnvelopeBase.extend({
      type: z.literal("handoff.rejected"),
      payload: HandoffAckPayload,
    }),
    ProtocolEnvelopeBase.extend({
      type: z.literal("status.update"),
      payload: StatusUpdatePayload,
    }),
    ProtocolEnvelopeBase.extend({
      type: z.literal("completion.report"),
      payload: CompletionReportPayload,
    }),
  ]),
);
/** Inferred type for the full protocol envelope (discriminated union). */
export type ProtocolEnvelope = z.infer<typeof ProtocolEnvelope>;
