import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProtocolMessage, ProtocolRouter } from "../router.js";
import type { ProtocolEnvelope } from "../../schemas/protocol.js";
import type { EventType } from "../../schemas/event.js";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";

let tmpDir: string;
let store: ITaskStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aof-protocol-router-test-"));
  store = new FilesystemTaskStore(tmpDir);
  await store.init();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const baseEnvelope: ProtocolEnvelope = {
  protocol: "aof",
  version: 1,
  projectId: "test-project",
  type: "status.update",
  taskId: "TASK-2026-02-09-058",
  fromAgent: "swe-backend",
  toAgent: "swe-qa",
  sentAt: "2026-02-09T21:00:00.000Z",
  payload: {
    taskId: "TASK-2026-02-09-058",
    agentId: "swe-backend",
    status: "blocked",
    progress: "Waiting on API key",
    blockers: ["API key pending"],
    notes: "ETA tomorrow",
  },
};

type TestLogger = {
  log: (type: EventType, actor: string, opts?: { taskId?: string; payload?: Record<string, unknown> }) => void;
};

const makeLogger = (): TestLogger => ({
  log: vi.fn(),
});

describe("parseProtocolMessage", () => {
  it("parses a protocol envelope from object payload", () => {
    const logger = makeLogger();
    const result = parseProtocolMessage({ payload: baseEnvelope }, logger);

    expect(result).toEqual(baseEnvelope);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("parses a protocol envelope from JSON string", () => {
    const logger = makeLogger();
    const result = parseProtocolMessage(JSON.stringify(baseEnvelope), logger);

    expect(result).toEqual(baseEnvelope);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("parses a protocol envelope from AOF/1 prefix", () => {
    const logger = makeLogger();
    const result = parseProtocolMessage(`AOF/1 ${JSON.stringify(baseEnvelope)}`, logger);

    expect(result).toEqual(baseEnvelope);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("logs and ignores invalid JSON", () => {
    const logger = makeLogger();
    const result = parseProtocolMessage("{", logger);

    expect(result).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      "protocol.message.rejected",
      "system",
      expect.objectContaining({
        payload: expect.objectContaining({ reason: "invalid_json" }),
      }),
    );
  });

  it("ignores non-protocol messages", () => {
    const logger = makeLogger();
    const result = parseProtocolMessage("hello world", logger);

    expect(result).toBeNull();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("logs and ignores envelopes missing required fields", () => {
    const logger = makeLogger();
    const result = parseProtocolMessage(
      JSON.stringify({ protocol: "aof", version: 1 }),
      logger,
    );

    expect(result).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      "protocol.message.rejected",
      "system",
      expect.objectContaining({
        payload: expect.objectContaining({ reason: "invalid_envelope" }),
      }),
    );
  });
});

describe("ProtocolRouter", () => {
  it("routes to the correct handler by type", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });
    
    // Create task in store first
    const task = await store.create({
      title: "Test Task",
      createdBy: "system",
      routing: { agent: baseEnvelope.fromAgent },
    });
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");

    const spy = vi.spyOn(router, "handleStatusUpdate");

    const envelope = { ...baseEnvelope, taskId: task.frontmatter.id };
    await router.route(envelope);

    expect(spy).toHaveBeenCalledWith(envelope, store);
  });

  it("logs unknown message types", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });

    await router.route({
      ...(baseEnvelope as ProtocolEnvelope),
      type: "unknown.type",
    } as ProtocolEnvelope);

    expect(logger.log).toHaveBeenCalledWith(
      "protocol.message.unknown",
      "system",
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "unknown.type",
        }),
      }),
    );
  });

  it("rejects envelope with invalid projectId", async () => {
    const logger = makeLogger();
    const projectStore = new FilesystemTaskStore(tmpDir);
    await projectStore.init();

    const resolver = vi.fn(() => undefined);
    const router = new ProtocolRouter({ store, logger, projectStoreResolver: resolver });

    const envelope = {
      ...baseEnvelope,
      projectId: "invalid-project",
    };

    await router.route(envelope);

    expect(resolver).toHaveBeenCalledWith("invalid-project");
    expect(logger.log).toHaveBeenCalledWith(
      "protocol.message.rejected",
      "system",
      expect.objectContaining({
        taskId: envelope.taskId,
        payload: expect.objectContaining({
          reason: "invalid_project_id",
          projectId: "invalid-project",
        }),
      }),
    );
  });

  it("rejects envelope when task not found in project", async () => {
    const logger = makeLogger();
    const projectStore = new FilesystemTaskStore(tmpDir);
    await projectStore.init();

    const resolver = vi.fn(() => projectStore);
    const router = new ProtocolRouter({ store, logger, projectStoreResolver: resolver });

    await router.route(baseEnvelope);

    expect(resolver).toHaveBeenCalledWith("test-project");
    expect(logger.log).toHaveBeenCalledWith(
      "protocol.message.rejected",
      "system",
      expect.objectContaining({
        taskId: baseEnvelope.taskId,
        payload: expect.objectContaining({
          reason: "task_not_found",
          projectId: "test-project",
        }),
      }),
    );
  });

  it("resolves correct project store and routes successfully", async () => {
    const logger = makeLogger();
    const projectStore = new FilesystemTaskStore(tmpDir);
    await projectStore.init();
    
    // Create task in project store
    const task = await projectStore.create({
      title: "Test Task",
      createdBy: "system",
      routing: { agent: baseEnvelope.fromAgent },
    });
    await projectStore.transition(task.frontmatter.id, "ready");
    await projectStore.transition(task.frontmatter.id, "in-progress");

    const resolver = vi.fn(() => projectStore);
    const router = new ProtocolRouter({ store, logger, projectStoreResolver: resolver });
    const spy = vi.spyOn(router, "handleStatusUpdate");

    const envelope = { ...baseEnvelope, taskId: task.frontmatter.id };
    await router.route(envelope);

    expect(resolver).toHaveBeenCalledWith("test-project");
    expect(spy).toHaveBeenCalledWith(envelope, projectStore);
    expect(logger.log).toHaveBeenCalledWith(
      "protocol.message.received",
      baseEnvelope.fromAgent,
      expect.any(Object),
    );
  });

  it("falls back to default store when no resolver provided", async () => {
    const logger = makeLogger();
    const router = new ProtocolRouter({ store, logger });
    
    // Create task in default store
    const task = await store.create({
      title: "Test Task",
      createdBy: "system",
      routing: { agent: baseEnvelope.fromAgent },
    });
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");

    const spy = vi.spyOn(router, "handleStatusUpdate");

    const envelope = { ...baseEnvelope, taskId: task.frontmatter.id };
    await router.route(envelope);

    expect(spy).toHaveBeenCalledWith(envelope, store);
  });
});
