import { describe, it, expect } from "vitest";
import {
  GateOutcome,
  Gate,
  GateHistoryEntry,
  ReviewContext,
  GateTransition,
  TestSpec,
} from "../gate.js";

describe("GateOutcome", () => {
  it("accepts valid outcomes", () => {
    expect(GateOutcome.parse("complete")).toBe("complete");
    expect(GateOutcome.parse("needs_review")).toBe("needs_review");
    expect(GateOutcome.parse("blocked")).toBe("blocked");
  });

  it("rejects invalid outcomes", () => {
    expect(() => GateOutcome.parse("invalid")).toThrow();
    expect(() => GateOutcome.parse("completed")).toThrow();
    expect(() => GateOutcome.parse("COMPLETE")).toThrow();
  });
});

describe("Gate", () => {
  it("validates a minimal gate definition", () => {
    const raw = {
      id: "dev",
      role: "swe-backend",
    };

    const result = Gate.parse(raw);
    expect(result.id).toBe("dev");
    expect(result.role).toBe("swe-backend");
    expect(result.canReject).toBe(false); // default
  });

  it("validates a full gate definition", () => {
    const raw = {
      id: "qa",
      role: "swe-qa",
      canReject: true,
      when: "status === 'review'",
      description: "QA validation gate",
      requireHuman: true,
      timeout: "2h",
      escalateTo: "swe-qa-lead",
    };

    const result = Gate.parse(raw);
    expect(result.id).toBe("qa");
    expect(result.role).toBe("swe-qa");
    expect(result.canReject).toBe(true);
    expect(result.when).toBe("status === 'review'");
    expect(result.description).toBe("QA validation gate");
    expect(result.requireHuman).toBe(true);
    expect(result.timeout).toBe("2h");
    expect(result.escalateTo).toBe("swe-qa-lead");
  });

  it("rejects empty id", () => {
    const raw = {
      id: "",
      role: "swe-backend",
    };

    expect(() => Gate.parse(raw)).toThrow();
  });

  it("rejects empty role", () => {
    const raw = {
      id: "dev",
      role: "",
    };

    expect(() => Gate.parse(raw)).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => Gate.parse({ id: "dev" })).toThrow();
    expect(() => Gate.parse({ role: "swe-backend" })).toThrow();
  });

  it("accepts optional fields as undefined", () => {
    const raw = {
      id: "dev",
      role: "swe-backend",
    };

    const result = Gate.parse(raw);
    expect(result.when).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.requireHuman).toBeUndefined();
    expect(result.timeout).toBeUndefined();
    expect(result.escalateTo).toBeUndefined();
  });
});

describe("GateHistoryEntry", () => {
  it("validates a minimal history entry", () => {
    const raw = {
      gate: "dev",
      role: "swe-backend",
      entered: "2026-02-16T23:00:00Z",
    };

    const result = GateHistoryEntry.parse(raw);
    expect(result.gate).toBe("dev");
    expect(result.role).toBe("swe-backend");
    expect(result.entered).toBe("2026-02-16T23:00:00Z");
    expect(result.blockers).toEqual([]); // default
  });

  it("validates a complete history entry", () => {
    const raw = {
      gate: "qa",
      role: "swe-qa",
      agent: "qa-bot",
      entered: "2026-02-16T23:00:00Z",
      exited: "2026-02-16T23:30:00Z",
      outcome: "complete",
      summary: "All tests passed",
      blockers: ["flaky-test-1", "missing-doc"],
      rejectionNotes: "Fix the flaky test",
      duration: 1800,
    };

    const result = GateHistoryEntry.parse(raw);
    expect(result.gate).toBe("qa");
    expect(result.role).toBe("swe-qa");
    expect(result.agent).toBe("qa-bot");
    expect(result.entered).toBe("2026-02-16T23:00:00Z");
    expect(result.exited).toBe("2026-02-16T23:30:00Z");
    expect(result.outcome).toBe("complete");
    expect(result.summary).toBe("All tests passed");
    expect(result.blockers).toEqual(["flaky-test-1", "missing-doc"]);
    expect(result.rejectionNotes).toBe("Fix the flaky test");
    expect(result.duration).toBe(1800);
  });

  it("rejects invalid datetime formats", () => {
    const raw = {
      gate: "dev",
      role: "swe-backend",
      entered: "2026-02-16",
    };

    expect(() => GateHistoryEntry.parse(raw)).toThrow();
  });

  it("rejects negative duration", () => {
    const raw = {
      gate: "dev",
      role: "swe-backend",
      entered: "2026-02-16T23:00:00Z",
      duration: -100,
    };

    expect(() => GateHistoryEntry.parse(raw)).toThrow();
  });

  it("accepts zero duration", () => {
    const raw = {
      gate: "dev",
      role: "swe-backend",
      entered: "2026-02-16T23:00:00Z",
      duration: 0,
    };

    const result = GateHistoryEntry.parse(raw);
    expect(result.duration).toBe(0);
  });
});

describe("ReviewContext", () => {
  it("validates a minimal review context", () => {
    const raw = {
      fromGate: "qa",
      fromRole: "swe-qa",
      timestamp: "2026-02-16T23:00:00Z",
    };

    const result = ReviewContext.parse(raw);
    expect(result.fromGate).toBe("qa");
    expect(result.fromRole).toBe("swe-qa");
    expect(result.timestamp).toBe("2026-02-16T23:00:00Z");
    expect(result.blockers).toEqual([]); // default
  });

  it("validates a full review context", () => {
    const raw = {
      fromGate: "qa",
      fromAgent: "qa-bot",
      fromRole: "swe-qa",
      timestamp: "2026-02-16T23:00:00Z",
      blockers: ["test-failure", "lint-error"],
      notes: "Please fix the linting errors before resubmission",
    };

    const result = ReviewContext.parse(raw);
    expect(result.fromGate).toBe("qa");
    expect(result.fromAgent).toBe("qa-bot");
    expect(result.fromRole).toBe("swe-qa");
    expect(result.timestamp).toBe("2026-02-16T23:00:00Z");
    expect(result.blockers).toEqual(["test-failure", "lint-error"]);
    expect(result.notes).toBe("Please fix the linting errors before resubmission");
  });

  it("rejects invalid datetime format", () => {
    const raw = {
      fromGate: "qa",
      fromRole: "swe-qa",
      timestamp: "not-a-date",
    };

    expect(() => ReviewContext.parse(raw)).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => ReviewContext.parse({ fromGate: "qa", fromRole: "swe-qa" })).toThrow();
    expect(() => ReviewContext.parse({ fromGate: "qa", timestamp: "2026-02-16T23:00:00Z" })).toThrow();
    expect(() => ReviewContext.parse({ fromRole: "swe-qa", timestamp: "2026-02-16T23:00:00Z" })).toThrow();
  });
});

describe("GateTransition", () => {
  it("validates a minimal transition", () => {
    const raw = {
      taskId: "TASK-2026-02-16-001",
      outcome: "complete",
      timestamp: "2026-02-16T23:00:00Z",
    };

    const result = GateTransition.parse(raw);
    expect(result.taskId).toBe("TASK-2026-02-16-001");
    expect(result.outcome).toBe("complete");
    expect(result.timestamp).toBe("2026-02-16T23:00:00Z");
    expect(result.skipped).toEqual([]); // default
  });

  it("validates a full transition", () => {
    const raw = {
      taskId: "TASK-2026-02-16-001",
      fromGate: "dev",
      toGate: "qa",
      outcome: "complete",
      agent: "swe-backend",
      timestamp: "2026-02-16T23:00:00Z",
      duration: 3600,
      skipped: ["security-scan", "perf-test"],
    };

    const result = GateTransition.parse(raw);
    expect(result.taskId).toBe("TASK-2026-02-16-001");
    expect(result.fromGate).toBe("dev");
    expect(result.toGate).toBe("qa");
    expect(result.outcome).toBe("complete");
    expect(result.agent).toBe("swe-backend");
    expect(result.timestamp).toBe("2026-02-16T23:00:00Z");
    expect(result.duration).toBe(3600);
    expect(result.skipped).toEqual(["security-scan", "perf-test"]);
  });

  it("rejects invalid outcome", () => {
    const raw = {
      taskId: "TASK-2026-02-16-001",
      outcome: "invalid",
      timestamp: "2026-02-16T23:00:00Z",
    };

    expect(() => GateTransition.parse(raw)).toThrow();
  });

  it("rejects negative duration", () => {
    const raw = {
      taskId: "TASK-2026-02-16-001",
      outcome: "complete",
      timestamp: "2026-02-16T23:00:00Z",
      duration: -100,
    };

    expect(() => GateTransition.parse(raw)).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => GateTransition.parse({ taskId: "TASK-2026-02-16-001", outcome: "complete" })).toThrow();
    expect(() => GateTransition.parse({ taskId: "TASK-2026-02-16-001", timestamp: "2026-02-16T23:00:00Z" })).toThrow();
    expect(() => GateTransition.parse({ outcome: "complete", timestamp: "2026-02-16T23:00:00Z" })).toThrow();
  });
});

describe("TestSpec", () => {
  it("validates a minimal test spec", () => {
    const raw = {
      given: "a user is logged in",
      when: "they submit a valid form",
      then: {},
    };

    const result = TestSpec.parse(raw);
    expect(result.given).toBe("a user is logged in");
    expect(result.when).toBe("they submit a valid form");
    expect(result.then).toEqual({});
  });

  it("validates a full test spec with status", () => {
    const raw = {
      given: "a user is logged in",
      when: "they submit a valid form",
      then: {
        status: 200,
      },
    };

    const result = TestSpec.parse(raw);
    expect(result.then.status).toBe(200);
  });

  it("validates a full test spec with body_contains", () => {
    const raw = {
      given: "a user is logged in",
      when: "they submit a valid form",
      then: {
        body_contains: ["success", "task created"],
      },
    };

    const result = TestSpec.parse(raw);
    expect(result.then.body_contains).toEqual(["success", "task created"]);
  });

  it("validates a full test spec with both status and body_contains", () => {
    const raw = {
      given: "a user is logged in",
      when: "they submit a valid form",
      then: {
        status: 201,
        body_contains: ["id", "created_at"],
      },
    };

    const result = TestSpec.parse(raw);
    expect(result.then.status).toBe(201);
    expect(result.then.body_contains).toEqual(["id", "created_at"]);
  });

  it("rejects non-integer status", () => {
    const raw = {
      given: "a user is logged in",
      when: "they submit a valid form",
      then: {
        status: 200.5,
      },
    };

    expect(() => TestSpec.parse(raw)).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => TestSpec.parse({ given: "test", when: "test" })).toThrow();
    expect(() => TestSpec.parse({ given: "test", then: {} })).toThrow();
    expect(() => TestSpec.parse({ when: "test", then: {} })).toThrow();
  });
});
