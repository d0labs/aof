import { z } from "zod";
import { TaskId, TaskStatus } from "./task.js";

// Protocol payload size limits (SEC-003)
export const MAX_SUMMARY_REF_LENGTH = 256;
export const MAX_NOTES_LENGTH = 10_000;
export const MAX_PROGRESS_LENGTH = 1_000;
export const MAX_REASON_LENGTH = 512;
export const MAX_ITEM_LENGTH = 256;
export const MAX_DELIVERABLES_COUNT = 50;
export const MAX_BLOCKERS_COUNT = 20;
export const MAX_CONTEXT_REFS_COUNT = 50;
export const MAX_ACCEPTANCE_CRITERIA_COUNT = 50;
export const MAX_EXPECTED_OUTPUTS_COUNT = 50;
export const MAX_CONSTRAINTS_COUNT = 50;

export const ProtocolMessageType = z.enum([
  "handoff.request",
  "handoff.accepted",
  "handoff.rejected",
  "status.update",
  "completion.report",
]);
export type ProtocolMessageType = z.infer<typeof ProtocolMessageType>;

export const CompletionOutcome = z.enum([
  "done",
  "blocked",
  "needs_review",
  "partial",
]);
export type CompletionOutcome = z.infer<typeof CompletionOutcome>;

export const TestReport = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .refine((d) => d.passed + d.failed <= d.total, {
    message: "passed + failed must not exceed total",
  });
export type TestReport = z.infer<typeof TestReport>;

export const CompletionReportPayload = z.object({
  outcome: CompletionOutcome,
  summaryRef: z.string().max(MAX_SUMMARY_REF_LENGTH),
  deliverables: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_DELIVERABLES_COUNT).default([]),
  tests: TestReport,
  blockers: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_BLOCKERS_COUNT).default([]),
  notes: z.string().max(MAX_NOTES_LENGTH),
});
export type CompletionReportPayload = z.infer<typeof CompletionReportPayload>;

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
export type StatusUpdatePayload = z.infer<typeof StatusUpdatePayload>;

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
export type HandoffRequestPayload = z.infer<typeof HandoffRequestPayload>;

export const HandoffAckPayload = z.object({
  taskId: TaskId,
  accepted: z.boolean(),
  reason: z.string().max(MAX_REASON_LENGTH).optional(),
});
export type HandoffAckPayload = z.infer<typeof HandoffAckPayload>;

// Preprocess to accept project_id alias
const preprocessProjectId = (val: unknown) => {
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("project_id" in obj && !("projectId" in obj)) {
      return { ...obj, projectId: obj.project_id };
    }
  }
  return val;
};

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
export type ProtocolEnvelope = z.infer<typeof ProtocolEnvelope>;
