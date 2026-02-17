/**
 * E2E Test: TaskStore Operations
 * 
 * Tests AOF TaskStore end-to-end without OpenClaw gateway dependency.
 * Verifies:
 * - Task creation and parsing
 * - Status transitions (backlog → ready → in-progress → done)
 * - Atomic file operations
 * - Lease management
 * - Task querying and listing
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { acquireLease, releaseLease, expireLeases } from "../../../src/store/lease.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "aof-test-data");

describe("E2E: TaskStore Operations", () => {
  let store: ITaskStore;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  it("should create a new task in backlog", async () => {
    const task = await store.create({
      title: "E2E Test Task",
      body: "# E2E Test Task\n\nThis is a test task.",
      priority: "normal",
      createdBy: "e2e-test-system",
    });

    expect(task).toBeDefined();
    expect(task.frontmatter.title).toBe("E2E Test Task");
    expect(task.frontmatter.status).toBe("backlog");
    expect(task.frontmatter.createdBy).toBe("e2e-test-system");

    // Verify task can be retrieved
    const retrieved = await store.get(task.frontmatter.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.frontmatter.id).toBe(task.frontmatter.id);
  });

  it("should transition task from backlog to ready", async () => {
    const task = await store.create({
      title: "Transition Test",
      body: "# Test",
      createdBy: "system",
    });

    await store.transition(task.frontmatter.id, "ready");

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("ready");
  });

  it("should list all tasks", async () => {
    const tasks = await store.list();
    expect(Array.isArray(tasks)).toBe(true);
  });

  it("should filter tasks by status", async () => {
    // Create task in backlog
    const task1 = await store.create({
      title: "Backlog Task",
      createdBy: "system",
    });

    // Create and transition to ready
    const task2 = await store.create({
      title: "Ready Task",
      createdBy: "system",
    });
    await store.transition(task2.frontmatter.id, "ready");

    const readyTasks = await store.list({ status: "ready" });
    expect(readyTasks.length).toBeGreaterThan(0);
    expect(readyTasks.every(t => t.frontmatter.status === "ready")).toBe(true);

    const backlogTasks = await store.list({ status: "backlog" });
    expect(backlogTasks.some(t => t.frontmatter.id === task1.frontmatter.id)).toBe(true);
  });

  it("should acquire and release lease on task", async () => {
    const task = await store.create({
      title: "Lease Test",
      createdBy: "system",
    });
    await store.transition(task.frontmatter.id, "ready");

    const agentId = "test-agent-1";
    const ttlMs = 30000;

    // Acquire lease
    const leased = await acquireLease(store, task.frontmatter.id, agentId, { 
      ttlMs,
      writeRunArtifacts: false, // Don't write artifacts in tests
    });
    expect(leased).toBeDefined();

    // Verify lease exists and task transitioned to in-progress
    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.lease).toBeDefined();
    expect(updated?.frontmatter.lease?.agent).toBe(agentId);
    expect(updated?.frontmatter.status).toBe("in-progress");

    // Release lease
    await releaseLease(store, task.frontmatter.id, agentId);

    // Verify lease removed and task moved to ready
    const released = await store.get(task.frontmatter.id);
    expect(released?.frontmatter.lease).toBeUndefined();
    expect(released?.frontmatter.status).toBe("ready");
  });

  it("should prevent double lease acquisition", async () => {
    const task = await store.create({
      title: "Double Lease Test",
      createdBy: "system",
    });
    await store.transition(task.frontmatter.id, "ready");

    const agent1 = "test-agent-1";
    const agent2 = "test-agent-2";

    // First agent acquires lease
    await acquireLease(store, task.frontmatter.id, agent1, { 
      ttlMs: 30000,
      writeRunArtifacts: false,
    });

    // Second agent should fail to acquire (throws error)
    await expect(
      acquireLease(store, task.frontmatter.id, agent2, { 
        ttlMs: 30000,
        writeRunArtifacts: false,
      })
    ).rejects.toThrow(/is leased to/);
  });

  it("should detect expired leases", async () => {
    const task = await store.create({
      title: "Expired Lease Test",
      createdBy: "system",
    });
    await store.transition(task.frontmatter.id, "ready");

    // Acquire lease with very short TTL
    const agentId = "test-agent-expire";
    const shortTtl = 100; // 100ms
    await acquireLease(store, task.frontmatter.id, agentId, { 
      ttlMs: shortTtl,
      writeRunArtifacts: false,
    });

    // Wait for lease to expire
    await new Promise(resolve => setTimeout(resolve, 150));

    // Verify lease is expired by running expireLeases
    const expiredIds = await expireLeases(store);
    expect(expiredIds).toContain(task.frontmatter.id);
  });

  it("should handle full task lifecycle", async () => {
    // Create in backlog
    const task = await store.create({
      title: "Lifecycle Test",
      body: "# Lifecycle Test\n\nFull lifecycle test.",
      priority: "high",
      createdBy: "system",
    });

    expect(task.frontmatter.status).toBe("backlog");

    // Transition to ready
    await store.transition(task.frontmatter.id, "ready");
    let updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("ready");

    // Transition to in-progress
    await store.transition(task.frontmatter.id, "in-progress");
    updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("in-progress");

    // Transition to review
    await store.transition(task.frontmatter.id, "review");
    updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("review");

    // Transition to done
    await store.transition(task.frontmatter.id, "done");
    updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("done");
  });

  it("should count tasks by status", async () => {
    // Create tasks in different statuses
    const task1 = await store.create({ title: "Task 1", createdBy: "system" });
    const task2 = await store.create({ title: "Task 2", createdBy: "system" });
    const task3 = await store.create({ title: "Task 3", createdBy: "system" });

    await store.transition(task2.frontmatter.id, "ready");
    await store.transition(task3.frontmatter.id, "ready");
    await store.transition(task3.frontmatter.id, "in-progress");

    // Count tasks by listing each status
    const backlogTasks = await store.list({ status: "backlog" });
    const readyTasks = await store.list({ status: "ready" });
    const inProgressTasks = await store.list({ status: "in-progress" });

    expect(backlogTasks.length).toBeGreaterThanOrEqual(1);
    expect(readyTasks.length).toBeGreaterThanOrEqual(1);
    expect(inProgressTasks.length).toBeGreaterThanOrEqual(1);
  });
});
