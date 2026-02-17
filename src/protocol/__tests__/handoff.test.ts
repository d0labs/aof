import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolRouter } from "../router.js";
import type { ProtocolEnvelope } from "../../schemas/protocol.js";
import type { EventType } from "../../schemas/event.js";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { acquireLease } from "../../store/lease.js";

let tmpDir: string;
let store: ITaskStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aof-handoff-test-"));
  store = new FilesystemTaskStore(tmpDir);
  await store.init();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

type LogCall = {
  type: EventType;
  actor: string;
  opts?: { taskId?: string; payload?: Record<string, unknown> };
};

const makeLogger = () => {
  const calls: LogCall[] = [];
  return {
    log: (type: EventType, actor: string, opts?: { taskId?: string; payload?: Record<string, unknown> }) => {
      calls.push({ type, actor, opts });
    },
    calls,
  };
};

describe("ProtocolRouter - Handoff Protocol", () => {
  it("writes handoff.json + handoff.md for valid request", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });

    // Create parent and child tasks
    const parent = await store.create({
      title: "Parent Task",
      createdBy: "architect",
    });
    await store.transition(parent.frontmatter.id, "ready");
    
    const child = await store.create({
      title: "Child Task",
      createdBy: "architect",
      parentId: parent.frontmatter.id,
      routing: { agent: "architect" },
    });
    await store.transition(child.frontmatter.id, "ready");

    const envelope: ProtocolEnvelope = {
      protocol: "aof",
      version: 1,
      projectId: "test-project",
      projectId: "test-project",
      type: "handoff.request",
      taskId: child.frontmatter.id,
      fromAgent: "architect",
      toAgent: "swe-backend",
      sentAt: "2026-02-10T12:00:00.000Z",
      payload: {
        taskId: child.frontmatter.id,
        parentTaskId: parent.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        acceptanceCriteria: ["Tests pass", "Code reviewed"],
        expectedOutputs: ["Implementation", "Tests"],
        contextRefs: ["spec.md"],
        constraints: ["No breaking changes"],
        dueBy: "2026-02-11T12:00:00.000Z",
      },
    };

    await router.route(envelope);

    // Verify files exist (task remains ready)
    const childDir = join(tmpDir, "tasks", "ready", child.frontmatter.id);
    const inputsDir = join(childDir, "inputs");
    const jsonPath = join(inputsDir, "handoff.json");
    const mdPath = join(inputsDir, "handoff.md");

    await expect(access(jsonPath)).resolves.toBeUndefined();
    await expect(access(mdPath)).resolves.toBeUndefined();

    // Verify JSON content
    const jsonContent = await readFile(jsonPath, "utf-8");
    const parsed = JSON.parse(jsonContent);
    expect(parsed).toEqual(envelope.payload);

    // Verify delegation.requested logged
    const delegationLogs = logger.calls.filter(c => c.type === "delegation.requested");
    expect(delegationLogs).toHaveLength(1);
    expect(delegationLogs[0].actor).toBe("architect");
    expect(delegationLogs[0].opts?.taskId).toBe(child.frontmatter.id);
  });

  it("handoff.md content includes sections; empty arrays show None", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });

    const parent = await store.create({
      title: "Parent Task",
      createdBy: "architect",
    });
    await store.transition(parent.frontmatter.id, "ready");
    
    const child = await store.create({
      title: "Child Task",
      createdBy: "architect",
      parentId: parent.frontmatter.id,
      routing: { agent: "architect" },
    });
    await store.transition(child.frontmatter.id, "ready");

    const envelope: ProtocolEnvelope = {
      protocol: "aof",
      version: 1,
      projectId: "test-project",
      type: "handoff.request",
      taskId: child.frontmatter.id,
      fromAgent: "architect",
      toAgent: "swe-backend",
      sentAt: "2026-02-10T12:00:00.000Z",
      payload: {
        taskId: child.frontmatter.id,
        parentTaskId: parent.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        acceptanceCriteria: [],
        expectedOutputs: ["output.txt"],
        contextRefs: [],
        constraints: [],
        dueBy: "2026-02-11T12:00:00.000Z",
      },
    };

    await router.route(envelope);

    // Task remains ready
    const childDir = join(tmpDir, "tasks", "ready", child.frontmatter.id);
    const mdPath = join(childDir, "inputs", "handoff.md");
    const mdContent = await readFile(mdPath, "utf-8");

    expect(mdContent).toContain("## Acceptance Criteria");
    expect(mdContent).toContain("None");
    expect(mdContent).toContain("## Expected Outputs");
    expect(mdContent).toContain("- output.txt");
    expect(mdContent).toContain("## Context References");
    expect(mdContent).toContain("## Constraints");
  });

  it("sets metadata.delegationDepth on child (0 -> 1)", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });

    const parent = await store.create({
      title: "Parent Task",
      createdBy: "architect",
    });
    await store.transition(parent.frontmatter.id, "ready");
    
    const child = await store.create({
      title: "Child Task",
      createdBy: "architect",
      parentId: parent.frontmatter.id,
      routing: { agent: "architect" },
    });
    await store.transition(child.frontmatter.id, "ready");

    const envelope: ProtocolEnvelope = {
      protocol: "aof",
      version: 1,
      projectId: "test-project",
      type: "handoff.request",
      taskId: child.frontmatter.id,
      fromAgent: "architect",
      toAgent: "swe-backend",
      sentAt: "2026-02-10T12:00:00.000Z",
      payload: {
        taskId: child.frontmatter.id,
        parentTaskId: parent.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        acceptanceCriteria: [],
        expectedOutputs: [],
        contextRefs: [],
        constraints: [],
        dueBy: "2026-02-11T12:00:00.000Z",
      },
    };

    await router.route(envelope);

    const updatedChild = await store.get(child.frontmatter.id);
    expect(updatedChild?.frontmatter.metadata?.delegationDepth).toBe(1);
  });

  it("rejects nested handoff when parent depth=1 (no files written; logs delegation.rejected)", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });

    // Parent with depth=1
    const parent = await store.create({
      title: "Parent Task",
      createdBy: "architect",
      metadata: { delegationDepth: 1 },
    });
    await store.transition(parent.frontmatter.id, "ready");
    
    const child = await store.create({
      title: "Child Task",
      createdBy: "architect",
      parentId: parent.frontmatter.id,
      routing: { agent: "architect" },
    });
    await store.transition(child.frontmatter.id, "ready");

    const envelope: ProtocolEnvelope = {
      protocol: "aof",
      version: 1,
      projectId: "test-project",
      type: "handoff.request",
      taskId: child.frontmatter.id,
      fromAgent: "architect",
      toAgent: "swe-backend",
      sentAt: "2026-02-10T12:00:00.000Z",
      payload: {
        taskId: child.frontmatter.id,
        parentTaskId: parent.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        acceptanceCriteria: [],
        expectedOutputs: [],
        contextRefs: [],
        constraints: [],
        dueBy: "2026-02-11T12:00:00.000Z",
      },
    };

    await router.route(envelope);

    // Verify no files written
    const childDir = join(tmpDir, "tasks", "ready", child.frontmatter.id);
    const jsonPath = join(childDir, "inputs", "handoff.json");
    const mdPath = join(childDir, "inputs", "handoff.md");

    await expect(access(jsonPath)).rejects.toThrow();
    await expect(access(mdPath)).rejects.toThrow();

    // Verify delegation.rejected logged
    const rejectedLogs = logger.calls.filter(c => c.type === "delegation.rejected");
    expect(rejectedLogs).toHaveLength(1);
    expect(rejectedLogs[0].opts?.payload?.reason).toBe("nested_delegation");
  });

  it("missing parent logs delegation.rejected + no files written", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });

    const child = await store.create({
      title: "Child Task",
      createdBy: "architect",
      routing: { agent: "architect" },
    });
    await store.transition(child.frontmatter.id, "ready");

    const envelope: ProtocolEnvelope = {
      protocol: "aof",
      version: 1,
      projectId: "test-project",
      type: "handoff.request",
      taskId: child.frontmatter.id,
      fromAgent: "architect",
      toAgent: "swe-backend",
      sentAt: "2026-02-10T12:00:00.000Z",
      payload: {
        taskId: child.frontmatter.id,
        parentTaskId: "TASK-MISSING",
        fromAgent: "architect",
        toAgent: "swe-backend",
        acceptanceCriteria: [],
        expectedOutputs: [],
        contextRefs: [],
        constraints: [],
        dueBy: "2026-02-11T12:00:00.000Z",
      },
    };

    await router.route(envelope);

    // Verify no files written
    const childDir = join(tmpDir, "tasks", "ready", child.frontmatter.id);
    const jsonPath = join(childDir, "inputs", "handoff.json");
    const mdPath = join(childDir, "inputs", "handoff.md");

    await expect(access(jsonPath)).rejects.toThrow();
    await expect(access(mdPath)).rejects.toThrow();

    // Verify delegation.rejected logged
    const rejectedLogs = logger.calls.filter(c => c.type === "delegation.rejected");
    expect(rejectedLogs).toHaveLength(1);
  });

  it("handoff.accepted logs delegation.accepted, no state change", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });

    const child = await store.create({
      title: "Child Task",
      createdBy: "architect",
      routing: { agent: "swe-backend" },
    });
    await store.transition(child.frontmatter.id, "ready");

    const envelope: ProtocolEnvelope = {
      protocol: "aof",
      version: 1,
      projectId: "test-project",
      type: "handoff.accepted",
      taskId: child.frontmatter.id,
      fromAgent: "swe-backend",
      toAgent: "architect",
      sentAt: "2026-02-10T12:00:00.000Z",
      payload: {
        taskId: child.frontmatter.id,
        accepted: true,
      },
    };

    await router.route(envelope);

    // Verify state unchanged (ready, no lease acquired)
    const updatedChild = await store.get(child.frontmatter.id);
    expect(updatedChild?.frontmatter.status).toBe("ready");

    // Verify delegation.accepted logged
    const acceptedLogs = logger.calls.filter(c => c.type === "delegation.accepted");
    expect(acceptedLogs).toHaveLength(1);
    expect(acceptedLogs[0].actor).toBe("swe-backend");
    expect(acceptedLogs[0].opts?.taskId).toBe(child.frontmatter.id);
  });

  it("handoff.rejected transitions child to blocked + logs transition and delegation.rejected", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });

    const child = await store.create({
      title: "Child Task",
      createdBy: "architect",
      routing: { agent: "swe-backend" },
    });
    await store.transition(child.frontmatter.id, "ready");

    const envelope: ProtocolEnvelope = {
      protocol: "aof",
      version: 1,
      projectId: "test-project",
      type: "handoff.rejected",
      taskId: child.frontmatter.id,
      fromAgent: "swe-backend",
      toAgent: "architect",
      sentAt: "2026-02-10T12:00:00.000Z",
      payload: {
        taskId: child.frontmatter.id,
        accepted: false,
        reason: "Insufficient context",
      },
    };

    await router.route(envelope);

    // Verify state transition to blocked
    const updatedChild = await store.get(child.frontmatter.id);
    expect(updatedChild?.frontmatter.status).toBe("blocked");

    // Verify task.transitioned logged (from ready)
    const transitionLogs = logger.calls.filter(c => c.type === "task.transitioned");
    expect(transitionLogs).toHaveLength(1);
    expect(transitionLogs[0].opts?.payload?.from).toBe("ready");
    expect(transitionLogs[0].opts?.payload?.to).toBe("blocked");
    expect(transitionLogs[0].opts?.payload?.reason).toBe("Insufficient context");

    // Verify delegation.rejected logged
    const rejectedLogs = logger.calls.filter(c => c.type === "delegation.rejected");
    expect(rejectedLogs).toHaveLength(1);
  });

  it("taskId mismatch (payload vs envelope) logs protocol.message.rejected", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });

    const parent = await store.create({
      title: "Parent Task",
      createdBy: "architect",
    });
    await store.transition(parent.frontmatter.id, "ready");
    
    const child = await store.create({
      title: "Child Task",
      createdBy: "architect",
      parentId: parent.frontmatter.id,
      routing: { agent: "architect" },
    });
    await store.transition(child.frontmatter.id, "ready");

    const envelope: ProtocolEnvelope = {
      protocol: "aof",
      version: 1,
      projectId: "test-project",
      type: "handoff.request",
      taskId: child.frontmatter.id,
      fromAgent: "architect",
      toAgent: "swe-backend",
      sentAt: "2026-02-10T12:00:00.000Z",
      payload: {
        taskId: "TASK-WRONG",  // Mismatch!
        parentTaskId: parent.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        acceptanceCriteria: [],
        expectedOutputs: [],
        contextRefs: [],
        constraints: [],
        dueBy: "2026-02-11T12:00:00.000Z",
      },
    };

    await router.route(envelope);

    // Verify protocol.message.rejected logged
    const rejectedLogs = logger.calls.filter(c => c.type === "protocol.message.rejected");
    expect(rejectedLogs).toHaveLength(1);

    // Verify no files written
    const childDir = join(tmpDir, "tasks", "ready", child.frontmatter.id);
    const jsonPath = join(childDir, "inputs", "handoff.json");
    await expect(access(jsonPath)).rejects.toThrow();
  });
});
