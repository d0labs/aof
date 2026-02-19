/**
 * Unit tests for dep-cascader.ts
 *
 * Uses a lightweight in-memory mock store — no filesystem required.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Task } from "../../schemas/task.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { EventLogger } from "../../events/logger.js";
import { cascadeOnCompletion, cascadeOnBlock } from "../dep-cascader.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(
  id: string,
  status: Task["frontmatter"]["status"],
  dependsOn: string[] = [],
): Task {
  return {
    frontmatter: {
      id,
      title: `Task ${id}`,
      status,
      priority: "normal",
      dependsOn,
      routing: { agent: "test-agent" },
      createdAt: "2026-01-01T00:00:00Z",
      createdBy: "test",
      metadata: {},
    },
    body: "",
  };
}

/** Minimal in-memory mock of ITaskStore. */
function makeMockStore(initialTasks: Task[]): {
  store: ITaskStore;
  tasks: Map<string, Task>;
} {
  const tasks = new Map<string, Task>(
    initialTasks.map((t) => [t.frontmatter.id, t]),
  );

  const store = {
    list: vi.fn(async () => Array.from(tasks.values())),
    transition: vi.fn(
      async (id: string, status: Task["frontmatter"]["status"]) => {
        const t = tasks.get(id);
        if (!t) throw new Error(`Task not found: ${id}`);
        const updated = {
          ...t,
          frontmatter: { ...t.frontmatter, status },
        };
        tasks.set(id, updated);
        return updated;
      },
    ),
    block: vi.fn(async (id: string, reason: string) => {
      const t = tasks.get(id);
      if (!t) throw new Error(`Task not found: ${id}`);
      const updated = {
        ...t,
        frontmatter: {
          ...t.frontmatter,
          status: "blocked" as const,
          metadata: { ...t.frontmatter.metadata, blockReason: reason },
        },
      };
      tasks.set(id, updated);
      return updated;
    }),
    // Unused methods — satisfy interface with stubs
    projectRoot: "/tmp",
    projectId: "TEST",
    tasksDir: "/tmp/tasks",
    init: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    getByPrefix: vi.fn(),
    countByStatus: vi.fn(),
    cancel: vi.fn(),
    updateBody: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    lint: vi.fn(),
    getTaskInputs: vi.fn(),
    getTaskOutputs: vi.fn(),
    writeTaskOutput: vi.fn(),
    addDep: vi.fn(),
    removeDep: vi.fn(),
    unblock: vi.fn(),
  } as unknown as ITaskStore;

  return { store, tasks };
}

/** Minimal EventLogger mock. */
function makeMockLogger(): { logger: EventLogger; logged: { type: string; opts: unknown }[] } {
  const logged: { type: string; opts: unknown }[] = [];
  const logger = {
    log: vi.fn(async (type: string, _actor: string, opts?: unknown) => {
      logged.push({ type, opts });
      return {};
    }),
  } as unknown as EventLogger;
  return { logger, logged };
}

// ── Tests: cascadeOnCompletion ────────────────────────────────────────────────

describe("cascadeOnCompletion", () => {
  it("promotes dependent B to ready when its only dep A is now done", async () => {
    const taskA = makeTask("A", "done");
    const taskB = makeTask("B", "backlog", ["A"]);
    const { store } = makeMockStore([taskA, taskB]);
    const { logger, logged } = makeMockLogger();

    const result = await cascadeOnCompletion("A", store, logger);

    expect(result.promoted).toEqual(["B"]);
    expect(result.skipped).toEqual([]);

    // Store should have transitioned B to ready
    expect(store.transition).toHaveBeenCalledWith("B", "ready", {
      reason: "dependency_satisfied",
    });

    // Should emit one cascade event
    expect(logged).toHaveLength(1);
    expect(logged[0].type).toBe("dependency.cascaded");
    const payload = (logged[0].opts as { payload: Record<string, unknown> })
      .payload;
    expect(payload.action).toBe("promote");
    expect(payload.trigger).toBe("A");
    expect(payload.count).toBe(1);
  });

  it("skips dependent B when it has another unmet dep C (still in-progress)", async () => {
    const taskA = makeTask("A", "done");
    const taskC = makeTask("C", "in-progress");
    const taskB = makeTask("B", "backlog", ["A", "C"]);
    const { store } = makeMockStore([taskA, taskB, taskC]);
    const { logger, logged } = makeMockLogger();

    const result = await cascadeOnCompletion("A", store, logger);

    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual(["B"]);

    expect(store.transition).not.toHaveBeenCalled();

    // Event still emitted (skipped tasks are reported)
    expect(logged).toHaveLength(1);
    const payload = (logged[0].opts as { payload: Record<string, unknown> })
      .payload;
    expect(payload.count).toBe(0); // 0 promoted
    expect(payload.action).toBe("promote");
  });

  it("emits no event when there are no dependents", async () => {
    const taskA = makeTask("A", "done");
    const taskX = makeTask("X", "backlog"); // unrelated
    const { store } = makeMockStore([taskA, taskX]);
    const { logger, logged } = makeMockLogger();

    const result = await cascadeOnCompletion("A", store, logger);

    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(logged).toHaveLength(0);
  });

  it("promotes a blocked dependent (not just backlog) when deps all done", async () => {
    const taskA = makeTask("A", "done");
    const taskB = makeTask("B", "blocked", ["A"]);
    const { store } = makeMockStore([taskA, taskB]);
    const { logger } = makeMockLogger();

    const result = await cascadeOnCompletion("A", store, logger);

    expect(result.promoted).toEqual(["B"]);
    expect(store.transition).toHaveBeenCalledWith("B", "ready", {
      reason: "dependency_satisfied",
    });
  });

  it("promotes multiple dependents when each has all deps done", async () => {
    const taskA = makeTask("A", "done");
    const taskB = makeTask("B", "backlog", ["A"]);
    const taskC = makeTask("C", "backlog", ["A"]);
    const { store } = makeMockStore([taskA, taskB, taskC]);
    const { logger, logged } = makeMockLogger();

    const result = await cascadeOnCompletion("A", store, logger);

    expect(result.promoted).toHaveLength(2);
    expect(result.promoted).toContain("B");
    expect(result.promoted).toContain("C");
    const payload = (logged[0].opts as { payload: Record<string, unknown> })
      .payload;
    expect(payload.count).toBe(2);
  });
});

// ── Tests: cascadeOnBlock ─────────────────────────────────────────────────────

describe("cascadeOnBlock", () => {
  it("blocks backlog dependent B when upstream dep A is blocked", async () => {
    const taskA = makeTask("A", "blocked");
    const taskB = makeTask("B", "backlog", ["A"]);
    const { store } = makeMockStore([taskA, taskB]);
    const { logger, logged } = makeMockLogger();

    const result = await cascadeOnBlock("A", store, logger);

    expect(result.blocked).toEqual(["B"]);
    expect(store.block).toHaveBeenCalledWith("B", "upstream blocked: A");

    expect(logged).toHaveLength(1);
    const payload = (logged[0].opts as { payload: Record<string, unknown> })
      .payload;
    expect(payload.action).toBe("block");
    expect(payload.trigger).toBe("A");
    expect(payload.count).toBe(1);
  });

  it("blocks a ready dependent (not just backlog)", async () => {
    const taskA = makeTask("A", "blocked");
    const taskB = makeTask("B", "ready", ["A"]);
    const { store } = makeMockStore([taskA, taskB]);
    const { logger } = makeMockLogger();

    const result = await cascadeOnBlock("A", store, logger);

    expect(result.blocked).toEqual(["B"]);
    expect(store.block).toHaveBeenCalledWith("B", "upstream blocked: A");
  });

  it("emits no event when no dependents exist", async () => {
    const taskA = makeTask("A", "blocked");
    const { store } = makeMockStore([taskA]);
    const { logger, logged } = makeMockLogger();

    const result = await cascadeOnBlock("A", store, logger);

    expect(result.blocked).toEqual([]);
    expect(logged).toHaveLength(0);
  });

  it("does not cascade to already-blocked dependents", async () => {
    const taskA = makeTask("A", "blocked");
    const taskB = makeTask("B", "blocked", ["A"]); // already blocked
    const { store } = makeMockStore([taskA, taskB]);
    const { logger, logged } = makeMockLogger();

    const result = await cascadeOnBlock("A", store, logger);

    // B is blocked, not in backlog/ready → no cascade
    expect(result.blocked).toEqual([]);
    expect(store.block).not.toHaveBeenCalled();
    expect(logged).toHaveLength(0);
  });
});
