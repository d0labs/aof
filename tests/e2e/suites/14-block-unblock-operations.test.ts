/**
 * E2E Test: Task Block/Unblock Operations
 * 
 * Tests block/unblock functionality for tasks:
 * - Blocking tasks from valid states (backlog, ready, in-progress)
 * - Rejecting block from invalid states (done, cancelled, already blocked)
 * - Unblocking tasks back to ready
 * - Metadata management (blockReason)
 * - Lease clearing on unblock
 * - Event emission
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { EventLogger } from "../../../src/events/logger.js";
import { acquireLease } from "../../../src/store/lease.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, readdir } from "node:fs/promises";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "aof-test-block-unblock");

describe("E2E: Task Block/Unblock Operations", () => {
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    logger = new EventLogger(join(TEST_DATA_DIR, "events"));
    store = new FilesystemTaskStore(TEST_DATA_DIR, { logger });
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("block() method", () => {
    it("should block a task from backlog status", async () => {
      const task = await store.create({
        title: "Test Task in Backlog",
        body: "This task should be blockable from backlog",
        createdBy: "test-system",
      });

      const blockedTask = await store.block(task.frontmatter.id, "Waiting for external dependency");

      expect(blockedTask.frontmatter.status).toBe("blocked");
      expect(blockedTask.frontmatter.metadata.blockReason).toBe("Waiting for external dependency");
      expect(blockedTask.frontmatter.updatedAt).toBeDefined();
      expect(blockedTask.frontmatter.lastTransitionAt).toBeDefined();
    });

    it("should block a task from ready status", async () => {
      const task = await store.create({
        title: "Test Task in Ready",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");

      const blockedTask = await store.block(task.frontmatter.id, "API endpoint not available");

      expect(blockedTask.frontmatter.status).toBe("blocked");
      expect(blockedTask.frontmatter.metadata.blockReason).toBe("API endpoint not available");
    });

    it("should block a task from in-progress status", async () => {
      const task = await store.create({
        title: "Test Task in Progress",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress", { agent: "test-agent" });

      const blockedTask = await store.block(task.frontmatter.id, "Discovered missing requirements");

      expect(blockedTask.frontmatter.status).toBe("blocked");
      expect(blockedTask.frontmatter.metadata.blockReason).toBe("Discovered missing requirements");
    });

    it("should reject blocking a task that is already blocked", async () => {
      const task = await store.create({
        title: "Already Blocked Task",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.block(task.frontmatter.id, "First blocker");

      await expect(
        store.block(task.frontmatter.id, "Second blocker")
      ).rejects.toThrow("already blocked");
    });

    it("should reject blocking a task in done status", async () => {
      const task = await store.create({
        title: "Completed Task",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.transition(task.frontmatter.id, "in-progress");
      await store.transition(task.frontmatter.id, "review");
      await store.transition(task.frontmatter.id, "done");

      await expect(
        store.block(task.frontmatter.id, "Cannot block done task")
      ).rejects.toThrow("terminal state");
    });

    it("should reject blocking a task in cancelled status", async () => {
      const task = await store.create({
        title: "Cancelled Task",
        createdBy: "test-system",
      });
      await store.cancel(task.frontmatter.id, "No longer needed");

      await expect(
        store.block(task.frontmatter.id, "Cannot block cancelled task")
      ).rejects.toThrow("terminal state");
    });

    it("should emit task.blocked event", async () => {
      const task = await store.create({
        title: "Event Test Task",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");

      await store.block(task.frontmatter.id, "Testing event emission");

      // Read events from JSONL file
      const eventsDir = join(TEST_DATA_DIR, "events");
      const files = await readdir(eventsDir);
      const todayFile = files.find(f => f.endsWith(".jsonl"));
      expect(todayFile).toBeDefined();

      const content = await readFile(join(eventsDir, todayFile!), "utf-8");
      const lines = content.trim().split("\n");
      const events = lines.map(line => JSON.parse(line));
      const blockedEvent = events.find(e => e.type === "task.blocked");
      
      expect(blockedEvent).toBeDefined();
      expect(blockedEvent?.taskId).toBe(task.frontmatter.id);
      expect(blockedEvent?.payload).toEqual({ reason: "Testing event emission" });
    });
  });

  describe("unblock() method", () => {
    it("should unblock a blocked task and transition to ready", async () => {
      const task = await store.create({
        title: "Task to Unblock",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.block(task.frontmatter.id, "Temporarily blocked");

      const unblockedTask = await store.unblock(task.frontmatter.id);

      expect(unblockedTask.frontmatter.status).toBe("ready");
      expect(unblockedTask.frontmatter.metadata.blockReason).toBeUndefined();
      expect(unblockedTask.frontmatter.updatedAt).toBeDefined();
      expect(unblockedTask.frontmatter.lastTransitionAt).toBeDefined();
    });

    it("should clear stale lease when unblocking", async () => {
      const task = await store.create({
        title: "Task with Lease",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");
      
      // Acquire a lease to simulate agent working on task
      await acquireLease(store, task.frontmatter.id, "test-agent", { ttlMs: 60000 });
      await store.transition(task.frontmatter.id, "in-progress", { agent: "test-agent" });
      
      // Get the task to verify it has a lease
      let taskWithLease = await store.get(task.frontmatter.id);
      expect(taskWithLease?.frontmatter.lease).toBeDefined();
      expect(taskWithLease?.frontmatter.lease?.agent).toBe("test-agent");
      
      // Block the task
      await store.block(task.frontmatter.id, "Needs review");
      
      // Unblock the task
      const unblockedTask = await store.unblock(task.frontmatter.id);

      // Lease should be cleared after unblock (transition to ready clears lease)
      expect(unblockedTask.frontmatter.status).toBe("ready");
      expect(unblockedTask.frontmatter.lease).toBeUndefined();
    });

    it("should reject unblocking a task not in blocked status", async () => {
      const task = await store.create({
        title: "Task in Ready",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");

      await expect(
        store.unblock(task.frontmatter.id)
      ).rejects.toThrow("not blocked");
    });

    it("should emit task.unblocked event", async () => {
      const task = await store.create({
        title: "Event Test Unblock",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");
      await store.block(task.frontmatter.id, "Test blocker");

      await store.unblock(task.frontmatter.id);

      // Read events from JSONL file
      const eventsDir = join(TEST_DATA_DIR, "events");
      const files = await readdir(eventsDir);
      const todayFile = files.find(f => f.endsWith(".jsonl"));
      expect(todayFile).toBeDefined();

      const content = await readFile(join(eventsDir, todayFile!), "utf-8");
      const lines = content.trim().split("\n");
      const events = lines.map(line => JSON.parse(line));
      const unblockedEvent = events.find(e => e.type === "task.unblocked");
      
      expect(unblockedEvent).toBeDefined();
      expect(unblockedEvent?.taskId).toBe(task.frontmatter.id);
    });
  });

  describe("block/unblock workflow integration", () => {
    it("should support multiple block/unblock cycles", async () => {
      const task = await store.create({
        title: "Cycling Task",
        createdBy: "test-system",
      });
      await store.transition(task.frontmatter.id, "ready");

      // First block/unblock cycle
      await store.block(task.frontmatter.id, "First blocker");
      let retrieved = await store.get(task.frontmatter.id);
      expect(retrieved?.frontmatter.status).toBe("blocked");
      
      await store.unblock(task.frontmatter.id);
      retrieved = await store.get(task.frontmatter.id);
      expect(retrieved?.frontmatter.status).toBe("ready");
      expect(retrieved?.frontmatter.metadata.blockReason).toBeUndefined();

      // Second block/unblock cycle
      await store.block(task.frontmatter.id, "Second blocker");
      retrieved = await store.get(task.frontmatter.id);
      expect(retrieved?.frontmatter.status).toBe("blocked");
      expect(retrieved?.frontmatter.metadata.blockReason).toBe("Second blocker");
      
      await store.unblock(task.frontmatter.id);
      retrieved = await store.get(task.frontmatter.id);
      expect(retrieved?.frontmatter.status).toBe("ready");
      expect(retrieved?.frontmatter.metadata.blockReason).toBeUndefined();
    });

    it("should preserve other metadata when blocking/unblocking", async () => {
      const task = await store.create({
        title: "Metadata Preservation Test",
        createdBy: "test-system",
      });
      
      // Update priority
      await store.update(task.frontmatter.id, {
        priority: "high",
      });
      
      await store.transition(task.frontmatter.id, "ready");

      // Block and verify priority preserved
      await store.block(task.frontmatter.id, "Temporary block");
      let retrieved = await store.get(task.frontmatter.id);
      expect(retrieved?.frontmatter.metadata.blockReason).toBe("Temporary block");
      expect(retrieved?.frontmatter.priority).toBe("high");
      expect(retrieved?.frontmatter.status).toBe("blocked");

      // Unblock and verify priority still preserved (but blockReason cleared)
      await store.unblock(task.frontmatter.id);
      retrieved = await store.get(task.frontmatter.id);
      expect(retrieved?.frontmatter.metadata.blockReason).toBeUndefined();
      expect(retrieved?.frontmatter.priority).toBe("high");
      expect(retrieved?.frontmatter.status).toBe("ready");
    });
  });
});
