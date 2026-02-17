import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { aofTaskUpdate, aofTaskComplete, aofStatusReport } from "../aof-tools.js";
import type { ToolResponseEnvelope } from "../envelope.js";

describe("AOF tool handlers", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-tools-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const readLastEvent = async (): Promise<{ type: string; payload: Record<string, unknown> }> => {
    const eventsDir = join(tmpDir, "events");
    const files = await readdir(eventsDir);
    const content = await readFile(join(eventsDir, files[0]!), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const event = JSON.parse(lines[lines.length - 1]!);
    return { type: event.type, payload: event.payload };
  };

  it("updates task body and transitions status", async () => {
    const task = await store.create({ title: "Update me", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");

    const result = await aofTaskUpdate(
      { store, logger },
      {
        taskId: task.frontmatter.id,
        body: "New body",
        status: "in-progress",
        actor: "swe-backend",
        reason: "work started",
      },
    );

    expect(result.status).toBe("in-progress");

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.body).toBe("New body");

    const lastEvent = await readLastEvent();
    expect(lastEvent.type).toBe("task.transitioned");
    expect(lastEvent.payload.to).toBe("in-progress");
  });

  it("marks task complete and logs completion", async () => {
    const task = await store.create({ title: "Complete me", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "review");

    const result = await aofTaskComplete(
      { store, logger },
      {
        taskId: task.frontmatter.id,
        actor: "swe-backend",
        summary: "All done",
      },
    );

    expect(result.status).toBe("done");

    const lastEvent = await readLastEvent();
    expect(lastEvent.type).toBe("task.completed");
  });

  it("reports task status counts", async () => {
    const taskA = await store.create({ title: "A", createdBy: "main" });
    await store.transition(taskA.frontmatter.id, "ready");
    const taskB = await store.create({ title: "B", createdBy: "main" });
    await store.transition(taskB.frontmatter.id, "ready");
    await store.transition(taskB.frontmatter.id, "in-progress");

    const report = await aofStatusReport({ store, logger }, { actor: "main" });

    expect(report.total).toBe(2);
    expect(report.byStatus.ready).toBe(1);
    expect(report.byStatus["in-progress"]).toBe(1);
  });

  describe("envelope format", () => {
    it("aofTaskUpdate returns envelope with summary", async () => {
      const task = await store.create({ title: "Test task", createdBy: "main" });
      await store.transition(task.frontmatter.id, "ready");

      const result = await aofTaskUpdate(
        { store, logger },
        {
          taskId: task.frontmatter.id,
          status: "in-progress",
          actor: "swe-backend",
        },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toBeDefined();
      expect(envelope.summary).toContain(task.frontmatter.id);
      expect(envelope.summary).toContain("in-progress");
      expect(envelope.meta?.taskId).toBe(task.frontmatter.id);
      expect(envelope.meta?.status).toBe("in-progress");
    });

    it("aofTaskComplete returns envelope with summary", async () => {
      const task = await store.create({ title: "Complete task", createdBy: "main" });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");

      const result = await aofTaskComplete(
        { store, logger },
        {
          taskId: task.frontmatter.id,
          actor: "swe-backend",
        },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toBeDefined();
      expect(envelope.summary).toContain("completed");
      expect(envelope.meta?.taskId).toBe(task.frontmatter.id);
      expect(envelope.meta?.status).toBe("done");
    });

    it("aofStatusReport returns envelope in full mode by default", async () => {
      const task = await store.create({ title: "Task A", createdBy: "main" });
      await store.transition(task.frontmatter.id, "ready");

      const result = await aofStatusReport({ store, logger }, { actor: "main" });

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toBeDefined();
      expect(envelope.details).toBeDefined();
      expect(envelope.summary).toContain("1 task");
    });

    it("aofStatusReport returns compact envelope when compact=true", async () => {
      const taskA = await store.create({ title: "Task A", createdBy: "main" });
      await store.transition(taskA.frontmatter.id, "ready");
      const taskB = await store.create({ title: "Task B", createdBy: "main" });
      await store.transition(taskB.frontmatter.id, "ready");
      await store.transition(taskB.frontmatter.id, "in-progress");

      const result = await aofStatusReport(
        { store, logger },
        { actor: "main", compact: true },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toBeDefined();
      expect(envelope.details).toBeUndefined();
      expect(envelope.summary).toContain("2 tasks");
      expect(envelope.summary).toContain("ready: 1");
      expect(envelope.summary).toContain("in-progress: 1");
    });

    it("aofStatusReport respects limit parameter", async () => {
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        const task = await store.create({ title: `Task ${i}`, createdBy: "main" });
        await store.transition(task.frontmatter.id, "ready");
      }

      const result = await aofStatusReport(
        { store, logger },
        { actor: "main", limit: 3 },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toContain("5 tasks");
      expect(envelope.details).toBeDefined();
      // Details should only list 3 tasks
      const taskLines = envelope.details!.split("\n").filter(line => line.startsWith("- "));
      expect(taskLines.length).toBe(3);
    });

    it("aofStatusReport compact mode with limit", async () => {
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        const task = await store.create({ title: `Task ${i}`, createdBy: "main" });
        await store.transition(task.frontmatter.id, "ready");
      }

      const result = await aofStatusReport(
        { store, logger },
        { actor: "main", compact: true, limit: 2 },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toContain("5 tasks");
      expect(envelope.details).toBeUndefined();
    });

    it("aofStatusReport handles empty task list", async () => {
      const result = await aofStatusReport({ store, logger }, { actor: "main" });

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toContain("0 tasks");
      expect(envelope.details).toBeDefined();
    });

    it("aofStatusReport compact mode with empty task list", async () => {
      const result = await aofStatusReport(
        { store, logger },
        { actor: "main", compact: true },
      );

      const envelope = result as unknown as ToolResponseEnvelope;
      expect(envelope.summary).toContain("0 tasks");
      expect(envelope.details).toBeUndefined();
    });
  });
});
