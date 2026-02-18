import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../task-store.js";
import type { ITaskStore } from "../interfaces.js";
import { EventLogger } from "../../events/logger.js";

describe("TaskStore block/unblock", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-test-"));
    const eventsDir = join(tmpDir, "events");
    logger = new EventLogger(eventsDir);
    store = new FilesystemTaskStore(tmpDir, { logger });
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("block()", () => {
    it("blocks a task from backlog state and stores reason", async () => {
      const task = await store.create({
        title: "Test task",
        body: "Do something",
        createdBy: "main",
      });

      expect(task.frontmatter.status).toBe("backlog");

      const blockedTask = await store.block(task.frontmatter.id, "Waiting for dependency");

      expect(blockedTask.frontmatter.status).toBe("blocked");
      expect(blockedTask.frontmatter.metadata.blockReason).toBe("Waiting for dependency");
    });

    it("blocks a task from ready state", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      await store.transition(task.frontmatter.id, "ready");
      const blockedTask = await store.block(task.frontmatter.id, "External blocker");

      expect(blockedTask.frontmatter.status).toBe("blocked");
      expect(blockedTask.frontmatter.metadata.blockReason).toBe("External blocker");
    });

    it("blocks a task from in-progress state", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress", { agent: "test-agent" });
      const blockedTask = await store.block(task.frontmatter.id, "Blocked by upstream");

      expect(blockedTask.frontmatter.status).toBe("blocked");
      expect(blockedTask.frontmatter.metadata.blockReason).toBe("Blocked by upstream");
    });

    it("rejects blocking a task in done state", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      // Transition through the workflow to done
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress", { agent: "test-agent" });
      await store.transition(task.frontmatter.id, "review");
      await store.transition(task.frontmatter.id, "done");

      await expect(
        store.block(task.frontmatter.id, "Cannot block completed task")
      ).rejects.toThrow(/Cannot block task .* in terminal state: done/);
    });

    it("rejects blocking a task in deadletter state", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "deadletter");

      await expect(
        store.block(task.frontmatter.id, "Cannot block deadletter task")
      ).rejects.toThrow(/Cannot block task .* in terminal state: deadletter/);
    });

    it("emits task.blocked event", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      await store.block(task.frontmatter.id, "Test reason");

      // Verify event was logged
      const events = await logger.query({ type: "task.blocked" });
      expect(events).toHaveLength(1);
      expect(events[0]!.taskId).toBe(task.frontmatter.id);
      expect(events[0]!.payload.reason).toBe("Test reason");
    });

    it("rejects blocking non-existent task", async () => {
      await expect(
        store.block("TASK-2026-01-01-999", "No such task")
      ).rejects.toThrow(/Task not found/);
    });
  });

  describe("unblock()", () => {
    it("unblocks a blocked task and clears reason", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      const blockedTask = await store.block(task.frontmatter.id, "Temporary block");
      expect(blockedTask.frontmatter.status).toBe("blocked");
      expect(blockedTask.frontmatter.metadata.blockReason).toBe("Temporary block");

      const unblockedTask = await store.unblock(task.frontmatter.id);
      expect(unblockedTask.frontmatter.status).toBe("ready");
      expect(unblockedTask.frontmatter.metadata.blockReason).toBeUndefined();
    });

    it("rejects unblocking a task not in blocked state", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      // Task is in backlog, not blocked
      await expect(
        store.unblock(task.frontmatter.id)
      ).rejects.toThrow(/Cannot unblock task .* that is not blocked \(current status: backlog\)/);
    });

    it("rejects unblocking a task in ready state", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      await store.transition(task.frontmatter.id, "ready");

      await expect(
        store.unblock(task.frontmatter.id)
      ).rejects.toThrow(/Cannot unblock task .* that is not blocked \(current status: ready\)/);
    });

    it("emits task.unblocked event", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      await store.block(task.frontmatter.id, "Test block");
      await store.unblock(task.frontmatter.id);

      // Verify event was logged
      const events = await logger.query({ type: "task.unblocked" });
      expect(events).toHaveLength(1);
      expect(events[0]!.taskId).toBe(task.frontmatter.id);
    });

    it("rejects unblocking non-existent task", async () => {
      await expect(
        store.unblock("TASK-2026-01-01-999")
      ).rejects.toThrow(/Task not found/);
    });
  });

  describe("block/unblock round-trip", () => {
    it("preserves task data through block/unblock cycle", async () => {
      const task = await store.create({
        title: "Test task",
        body: "Original content",
        priority: "high",
        createdBy: "main",
      });

      const blocked = await store.block(task.frontmatter.id, "Testing");
      const unblocked = await store.unblock(task.frontmatter.id);

      expect(unblocked.frontmatter.title).toBe("Test task");
      expect(unblocked.body).toBe("Original content");
      expect(unblocked.frontmatter.priority).toBe("high");
      expect(unblocked.frontmatter.status).toBe("ready");
      expect(unblocked.frontmatter.metadata.blockReason).toBeUndefined();
    });

    it("allows blocking the same task multiple times", async () => {
      const task = await store.create({
        title: "Test task",
        createdBy: "main",
      });

      await store.block(task.frontmatter.id, "First block");
      await store.unblock(task.frontmatter.id);
      
      const blocked2 = await store.block(task.frontmatter.id, "Second block");
      expect(blocked2.frontmatter.status).toBe("blocked");
      expect(blocked2.frontmatter.metadata.blockReason).toBe("Second block");
    });
  });

  describe("XRAY-004: stale lease cleared on unblock", () => {
    it("clears stale lease when unblocking to ready", async () => {
      const task = await store.create({ title: "XRAY-004 regression", createdBy: "main" });
      const id = task.frontmatter.id;

      await store.transition(id, "ready");
      await store.transition(id, "in-progress", { agent: "test-agent" });
      await store.block(id, "Upstream blocked");

      // Inject a stale lease on the blocked task (simulates the bug scenario)
      const blocked = await store.get(id);
      blocked!.frontmatter.lease = {
        agent: "test-agent",
        acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_800_000).toISOString(),
        renewCount: 0,
      };
      const wfa = (await import("write-file-atomic")).default;
      const { serializeTask } = await import("../task-parser.js");
      await wfa(blocked!.path!, serializeTask(blocked!));

      // Unblock → ready: lease must be cleared
      const recovered = await store.unblock(id);
      expect(recovered.frontmatter.status).toBe("ready");
      expect(recovered.frontmatter.lease).toBeUndefined();

      // Verify on disk
      const reloaded = await store.get(id);
      expect(reloaded!.frontmatter.lease).toBeUndefined();
    });
  });
});
