import { describe, it, expect } from "vitest";
import {
  ProtocolEnvelope,
  CompletionReportPayload,
  StatusUpdatePayload,
  HandoffRequestPayload,
  HandoffAckPayload,
} from "../protocol.js";
import { ProtocolEnvelope as ProtocolEnvelopeFromIndex } from "../index.js";

describe("protocol schemas", () => {
  const completionPayload = {
    outcome: "partial",
    summaryRef: "outputs/summary.md",
    deliverables: ["src/foo.ts"],
    tests: { total: 120, passed: 120, failed: 0 },
    blockers: ["Awaiting API key"],
    notes: "Implemented core logic; needs QA review.",
  };

  const statusPayload = {
    taskId: "TASK-2026-02-09-057",
    agentId: "swe-backend",
    status: "blocked",
    progress: "Implemented core logic; waiting on API key",
    blockers: ["Awaiting API key"],
    notes: "ETA after credentials arrive",
  };

  const handoffRequestPayload = {
    taskId: "TASK-2026-02-09-060",
    parentTaskId: "TASK-2026-02-09-057",
    fromAgent: "swe-backend",
    toAgent: "swe-qa",
    acceptanceCriteria: ["All tests pass", "Update docs"],
    expectedOutputs: ["tests/report.md", "docs/QA.md"],
    contextRefs: [
      "tasks/in-progress/TASK-2026-02-09-057.md",
      "tasks/in-progress/TASK-2026-02-09-057/outputs/handoff.md",
    ],
    constraints: ["No new dependencies"],
    dueBy: "2026-02-10T12:00:00.000Z",
  };

  const handoffAckPayload = {
    taskId: "TASK-2026-02-09-060",
    accepted: true,
    reason: "Looks good",
  };

  it("parses valid payloads", () => {
    const cases = [
      CompletionReportPayload.safeParse(completionPayload),
      StatusUpdatePayload.safeParse(statusPayload),
      HandoffRequestPayload.safeParse(handoffRequestPayload),
      HandoffAckPayload.safeParse(handoffAckPayload),
    ];

    for (const result of cases) {
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid payloads", () => {
    const cases = [
      CompletionReportPayload.safeParse({ ...completionPayload, outcome: "done-ish" }),
      StatusUpdatePayload.safeParse({ ...statusPayload, taskId: "not-a-task" }),
      HandoffRequestPayload.safeParse({ ...handoffRequestPayload, dueBy: "soon" }),
      HandoffAckPayload.safeParse({ ...handoffAckPayload, accepted: "yes" }),
    ];

    for (const result of cases) {
      expect(result.success).toBe(false);
    }
  });

  it("parses a valid protocol envelope", () => {
    const envelope = {
      protocol: "aof",
      version: 1,
      projectId: "aof",
      type: "status.update",
      taskId: "TASK-2026-02-09-057",
      fromAgent: "swe-backend",
      toAgent: "swe-qa",
      sentAt: "2026-02-09T21:00:00.000Z",
      payload: statusPayload,
    };

    const result = ProtocolEnvelope.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it("rejects invalid protocol envelope", () => {
    const envelope = {
      protocol: "not-aof",
      version: 1,
      projectId: "aof",
      type: "status.update",
      taskId: "TASK-2026-02-09-057",
      fromAgent: "swe-backend",
      toAgent: "swe-qa",
      sentAt: "2026-02-09T21:00:00.000Z",
      payload: statusPayload,
    };

    const result = ProtocolEnvelope.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it("requires projectId", () => {
    const envelope = {
      protocol: "aof",
      version: 1,
      type: "status.update",
      taskId: "TASK-2026-02-09-057",
      fromAgent: "swe-backend",
      toAgent: "swe-qa",
      sentAt: "2026-02-09T21:00:00.000Z",
      payload: statusPayload,
    };

    const result = ProtocolEnvelope.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it("accepts project_id alias", () => {
    const envelope = {
      protocol: "aof",
      version: 1,
      project_id: "aof",
      type: "status.update",
      taskId: "TASK-2026-02-09-057",
      fromAgent: "swe-backend",
      toAgent: "swe-qa",
      sentAt: "2026-02-09T21:00:00.000Z",
      payload: statusPayload,
    };

    const result = ProtocolEnvelope.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe("aof");
    }
  });

  it("accepts optional taskRelpath", () => {
    const envelope = {
      protocol: "aof",
      version: 1,
      projectId: "aof",
      taskRelpath: "tasks/in-progress/TASK-2026-02-09-057.md",
      type: "status.update",
      taskId: "TASK-2026-02-09-057",
      fromAgent: "swe-backend",
      toAgent: "swe-qa",
      sentAt: "2026-02-09T21:00:00.000Z",
      payload: statusPayload,
    };

    const result = ProtocolEnvelope.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskRelpath).toBe("tasks/in-progress/TASK-2026-02-09-057.md");
    }
  });

  it("exports protocol schemas from index", () => {
    expect(ProtocolEnvelopeFromIndex).toBe(ProtocolEnvelope);
  });

  describe("SEC-003: payload size limits", () => {
    describe("boundary cases (valid at limit)", () => {
      it("accepts summaryRef at exactly 256 chars", () => {
        const payload = {
          ...completionPayload,
          summaryRef: "a".repeat(256),
        };
        const result = CompletionReportPayload.safeParse(payload);
        expect(result.success).toBe(true);
      });

      it("accepts notes at exactly 10,000 chars", () => {
        const payload = {
          ...completionPayload,
          notes: "x".repeat(10_000),
        };
        const result = CompletionReportPayload.safeParse(payload);
        expect(result.success).toBe(true);
      });

      it("accepts deliverables with exactly 50 items", () => {
        const payload = {
          ...completionPayload,
          deliverables: Array.from({ length: 50 }, (_, i) => `file${i}.ts`),
        };
        const result = CompletionReportPayload.safeParse(payload);
        expect(result.success).toBe(true);
      });

      it("accepts contextRefs with exactly 50 items", () => {
        const payload = {
          ...handoffRequestPayload,
          contextRefs: Array.from({ length: 50 }, (_, i) => `ref${i}`),
        };
        const result = HandoffRequestPayload.safeParse(payload);
        expect(result.success).toBe(true);
      });
    });

    describe("over-limit rejection cases", () => {
      it("rejects summaryRef with 257 chars", () => {
        const payload = {
          ...completionPayload,
          summaryRef: "a".repeat(257),
        };
        const result = CompletionReportPayload.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("summaryRef");
        }
      });

      it("rejects notes with 10,001 chars", () => {
        const payload = {
          ...completionPayload,
          notes: "x".repeat(10_001),
        };
        const result = CompletionReportPayload.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("notes");
        }
      });

      it("rejects deliverables with 51 items", () => {
        const payload = {
          ...completionPayload,
          deliverables: Array.from({ length: 51 }, (_, i) => `file${i}.ts`),
        };
        const result = CompletionReportPayload.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("deliverables");
        }
      });

      it("rejects deliverables with item longer than 256 chars", () => {
        const payload = {
          ...completionPayload,
          deliverables: ["a".repeat(257)],
        };
        const result = CompletionReportPayload.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("deliverables");
        }
      });

      it("rejects contextRefs with 51 items", () => {
        const payload = {
          ...handoffRequestPayload,
          contextRefs: Array.from({ length: 51 }, (_, i) => `ref${i}`),
        };
        const result = HandoffRequestPayload.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("contextRefs");
        }
      });

      it("rejects contextRefs with item longer than 256 chars", () => {
        const payload = {
          ...handoffRequestPayload,
          contextRefs: ["a".repeat(257)],
        };
        const result = HandoffRequestPayload.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("contextRefs");
        }
      });

      it("rejects progress with 1,001 chars", () => {
        const payload = {
          ...statusPayload,
          progress: "x".repeat(1_001),
        };
        const result = StatusUpdatePayload.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("progress");
        }
      });

      it("rejects reason with 513 chars", () => {
        const payload = {
          ...handoffAckPayload,
          reason: "x".repeat(513),
        };
        const result = HandoffAckPayload.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("reason");
        }
      });
    });
  });

  describe("TestReport cross-field validation", () => {
    it("accepts valid test counts where passed + failed <= total", () => {
      const result = CompletionReportPayload.safeParse({
        ...completionPayload,
        tests: { total: 10, passed: 8, failed: 2 },
      });
      expect(result.success).toBe(true);
    });

    it("accepts test counts where passed + failed < total (some skipped)", () => {
      const result = CompletionReportPayload.safeParse({
        ...completionPayload,
        tests: { total: 10, passed: 7, failed: 2 },
      });
      expect(result.success).toBe(true);
    });

    it("rejects test counts where passed + failed > total", () => {
      const result = CompletionReportPayload.safeParse({
        ...completionPayload,
        tests: { total: 10, passed: 8, failed: 5 },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("passed + failed must not exceed total");
      }
    });
  });
});
