import { describe, it, expect } from "vitest";
import { TaskFrontmatter, TaskStatus, isValidTransition } from "../task.js";

describe("TaskStatus", () => {
  it("accepts valid statuses per BRD", () => {
    const valid = ["backlog", "ready", "in-progress", "blocked", "review", "done"];
    for (const s of valid) {
      expect(TaskStatus.safeParse(s).success).toBe(true);
    }
  });

  it("rejects invalid statuses", () => {
    expect(TaskStatus.safeParse("invalid").success).toBe(false);
    expect(TaskStatus.safeParse("").success).toBe(false);
    expect(TaskStatus.safeParse("pending").success).toBe(false);
    expect(TaskStatus.safeParse("assigned").success).toBe(false);
  });
});

describe("isValidTransition", () => {
  it("allows backlog → ready", () => {
    expect(isValidTransition("backlog", "ready")).toBe(true);
  });

  it("allows ready → in-progress", () => {
    expect(isValidTransition("ready", "in-progress")).toBe(true);
  });

  it("allows in-progress → review", () => {
    expect(isValidTransition("in-progress", "review")).toBe(true);
  });

  it("allows review → done", () => {
    expect(isValidTransition("review", "done")).toBe(true);
  });

  it("allows any → blocked", () => {
    for (const from of ["backlog", "ready", "in-progress", "review"] as const) {
      expect(isValidTransition(from, "blocked")).toBe(true);
    }
  });

  it("allows blocked → ready (unblock)", () => {
    expect(isValidTransition("blocked", "ready")).toBe(true);
  });

  it("disallows backlog → done", () => {
    expect(isValidTransition("backlog", "done")).toBe(false);
  });

  it("disallows done → anything", () => {
    for (const s of TaskStatus.options) {
      expect(isValidTransition("done", s)).toBe(false);
    }
  });
});

describe("TaskFrontmatter", () => {
  const validTask = {
    schemaVersion: 1,
    id: "TASK-2026-02-06-001",
    project: "AOF",
    title: "Test task",
    status: "backlog",
    priority: "normal",
    createdAt: "2026-02-06T19:00:00Z",
    updatedAt: "2026-02-06T19:00:00Z",
    lastTransitionAt: "2026-02-06T19:00:00Z",
    createdBy: "main",
  };

  it("parses a valid task frontmatter", () => {
    const result = TaskFrontmatter.safeParse(validTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe(validTask.id);
      expect(result.data.routing.tags).toEqual([]);
      expect(result.data.dependsOn).toEqual([]);
    }
  });

  it("parses a valid subtask id", () => {
    const result = TaskFrontmatter.safeParse({ ...validTask, id: "TASK-2026-02-06-001-01" });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const { title: _, ...noTitle } = validTask;
    expect(TaskFrontmatter.safeParse(noTitle).success).toBe(false);
  });

  it("rejects invalid schema version", () => {
    expect(TaskFrontmatter.safeParse({ ...validTask, schemaVersion: 2 }).success).toBe(false);
  });

  it("rejects invalid task id", () => {
    expect(TaskFrontmatter.safeParse({ ...validTask, id: "not-a-task-id" }).success).toBe(false);
  });

  it("applies defaults for optional fields", () => {
    const result = TaskFrontmatter.parse(validTask);
    expect(result.priority).toBe("normal");
    expect(result.routing).toEqual({ tags: [] });
    expect(result.dependsOn).toEqual([]);
    expect(result.metadata).toEqual({});
  });
});
