import { describe, it, expect } from "vitest";
import { TaskFrontmatter, TaskRouting } from "../task.js";

describe("TaskFrontmatter - gate workflow extensions", () => {
  const baseTaskFrontmatter = {
    schemaVersion: 1,
    id: "TASK-2026-02-16-001",
    project: "AOF",
    title: "Test Task",
    status: "backlog",
    priority: "normal",
    routing: {},
    createdAt: "2026-02-16T19:00:00Z",
    updatedAt: "2026-02-16T19:00:00Z",
    lastTransitionAt: "2026-02-16T19:00:00Z",
    createdBy: "main",
    dependsOn: [],
    metadata: {},
  } as const;

  it("accepts task without gate fields (backward compat)", () => {
    const result = TaskFrontmatter.safeParse(baseTaskFrontmatter);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gate).toBeUndefined();
      expect(result.data.gateHistory).toEqual([]);
      expect(result.data.reviewContext).toBeUndefined();
      expect(result.data.tests).toEqual([]);
      expect(result.data.testsFile).toBeUndefined();
    }
  });

  it("accepts task with gate state", () => {
    const withGate = {
      ...baseTaskFrontmatter,
      gate: {
        current: "dev",
        entered: "2026-02-16T20:00:00Z",
      },
    };
    const result = TaskFrontmatter.safeParse(withGate);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gate?.current).toBe("dev");
      expect(result.data.gate?.entered).toBe("2026-02-16T20:00:00Z");
    }
  });

  it("rejects gate with empty current string", () => {
    const withEmptyGate = {
      ...baseTaskFrontmatter,
      gate: {
        current: "",
        entered: "2026-02-16T20:00:00Z",
      },
    };
    const result = TaskFrontmatter.safeParse(withEmptyGate);
    expect(result.success).toBe(false);
  });

  it("rejects gate with invalid datetime", () => {
    const withInvalidDate = {
      ...baseTaskFrontmatter,
      gate: {
        current: "dev",
        entered: "not-a-date",
      },
    };
    const result = TaskFrontmatter.safeParse(withInvalidDate);
    expect(result.success).toBe(false);
  });

  it("accepts task with gateHistory", () => {
    const withHistory = {
      ...baseTaskFrontmatter,
      gateHistory: [
        {
          gate: "dev",
          role: "swe-backend",
          agent: "agent-1",
          entered: "2026-02-16T20:00:00Z",
          exited: "2026-02-16T21:00:00Z",
          outcome: "complete",
          summary: "All tests passed",
          blockers: [],
          duration: 3600,
        },
      ],
    };
    const result = TaskFrontmatter.safeParse(withHistory);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gateHistory).toHaveLength(1);
      expect(result.data.gateHistory[0].gate).toBe("dev");
      expect(result.data.gateHistory[0].outcome).toBe("complete");
      expect(result.data.gateHistory[0].duration).toBe(3600);
    }
  });

  it("accepts gateHistory entry without optional fields", () => {
    const withMinimalHistory = {
      ...baseTaskFrontmatter,
      gateHistory: [
        {
          gate: "dev",
          role: "swe-backend",
          entered: "2026-02-16T20:00:00Z",
        },
      ],
    };
    const result = TaskFrontmatter.safeParse(withMinimalHistory);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gateHistory[0].agent).toBeUndefined();
      expect(result.data.gateHistory[0].exited).toBeUndefined();
      expect(result.data.gateHistory[0].outcome).toBeUndefined();
      expect(result.data.gateHistory[0].blockers).toEqual([]);
    }
  });

  it("accepts task with reviewContext", () => {
    const withReview = {
      ...baseTaskFrontmatter,
      reviewContext: {
        fromGate: "qa",
        fromRole: "swe-qa",
        fromAgent: "qa-agent",
        timestamp: "2026-02-16T22:00:00Z",
        blockers: ["Test coverage below 80%", "Missing error handling"],
        notes: "Please add unit tests for edge cases",
      },
    };
    const result = TaskFrontmatter.safeParse(withReview);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reviewContext?.fromGate).toBe("qa");
      expect(result.data.reviewContext?.blockers).toHaveLength(2);
      expect(result.data.reviewContext?.notes).toBe("Please add unit tests for edge cases");
    }
  });

  it("accepts reviewContext without optional fields", () => {
    const withMinimalReview = {
      ...baseTaskFrontmatter,
      reviewContext: {
        fromGate: "qa",
        fromRole: "swe-qa",
        timestamp: "2026-02-16T22:00:00Z",
      },
    };
    const result = TaskFrontmatter.safeParse(withMinimalReview);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reviewContext?.fromAgent).toBeUndefined();
      expect(result.data.reviewContext?.blockers).toEqual([]);
      expect(result.data.reviewContext?.notes).toBeUndefined();
    }
  });

  it("accepts task with tests", () => {
    const withTests = {
      ...baseTaskFrontmatter,
      tests: [
        {
          given: "a valid user is authenticated",
          when: "they submit a task creation request",
          then: {
            status: 201,
            body_contains: ["TASK-", "created"],
          },
        },
        {
          given: "an unauthenticated user",
          when: "they try to create a task",
          then: {
            status: 401,
          },
        },
      ],
    };
    const result = TaskFrontmatter.safeParse(withTests);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tests).toHaveLength(2);
      expect(result.data.tests[0].given).toBe("a valid user is authenticated");
      expect(result.data.tests[0].then.status).toBe(201);
      expect(result.data.tests[1].then.body_contains).toBeUndefined();
    }
  });

  it("accepts task with testsFile reference", () => {
    const withTestsFile = {
      ...baseTaskFrontmatter,
      testsFile: "tests/acceptance/task-creation.yaml",
    };
    const result = TaskFrontmatter.safeParse(withTestsFile);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.testsFile).toBe("tests/acceptance/task-creation.yaml");
    }
  });

  it("accepts task with all gate fields", () => {
    const withAllGateFields = {
      ...baseTaskFrontmatter,
      gate: {
        current: "qa",
        entered: "2026-02-16T20:00:00Z",
      },
      gateHistory: [
        {
          gate: "dev",
          role: "swe-backend",
          entered: "2026-02-16T19:00:00Z",
          exited: "2026-02-16T20:00:00Z",
          outcome: "complete",
        },
      ],
      reviewContext: {
        fromGate: "security",
        fromRole: "swe-security",
        timestamp: "2026-02-16T18:00:00Z",
        blockers: ["SQL injection vulnerability"],
      },
      tests: [
        {
          given: "a task exists",
          when: "it is updated",
          then: { status: 200 },
        },
      ],
      testsFile: "tests/task.yaml",
    };
    const result = TaskFrontmatter.safeParse(withAllGateFields);
    expect(result.success).toBe(true);
  });
});

describe("TaskRouting - workflow extension", () => {
  it("accepts routing without workflow (backward compat)", () => {
    const routing = {
      role: "swe-backend",
      tags: ["typescript", "api"],
    };
    const result = TaskRouting.safeParse(routing);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflow).toBeUndefined();
    }
  });

  it("accepts routing with workflow", () => {
    const routing = {
      role: "swe-backend",
      workflow: "standard-sdlc",
    };
    const result = TaskRouting.safeParse(routing);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflow).toBe("standard-sdlc");
    }
  });

  it("accepts empty routing with defaults", () => {
    const result = TaskRouting.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
      expect(result.data.workflow).toBeUndefined();
    }
  });
});
