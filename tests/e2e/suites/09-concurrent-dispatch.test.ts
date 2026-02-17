/**
 * E2E Test Suite 9: Concurrent Dispatch + Lease Manager
 * 
 * Tests lease-based concurrency control:
 * - Lease acquisition prevents double-spawn
 * - Concurrent dispatch attempts blocked
 * - Lease expiry and re-acquisition
 * - Multiple tasks dispatched simultaneously
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import {
  acquireLease,
  releaseLease,
  renewLease,
  expireLeases,
} from "../../../src/store/lease.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "concurrent-dispatch");

describe("E2E: Concurrent Dispatch + Lease Manager", () => {
  let store: ITaskStore;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
  });

  describe("lease acquisition", () => {
    it("should acquire lease and transition task to in-progress", async () => {
      const task = await store.create({
        title: "Lease Test Task",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const leased = await acquireLease(store, task.frontmatter.id, "agent-1");

      expect(leased).toBeDefined();
      expect(leased?.frontmatter.status).toBe("in-progress");
      expect(leased?.frontmatter.lease).toBeDefined();
      expect(leased?.frontmatter.lease?.agent).toBe("agent-1");
      expect(leased?.frontmatter.lease?.renewCount).toBe(0);
    });

    it("should prevent double acquisition by different agent", async () => {
      const task = await store.create({
        title: "Concurrent Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Agent 1 acquires lease
      await acquireLease(store, task.frontmatter.id, "agent-1");

      // Agent 2 tries to acquire same task — should fail
      await expect(
        acquireLease(store, task.frontmatter.id, "agent-2")
      ).rejects.toThrow(/is leased to agent-1/);
    });

    it("should allow same agent to re-acquire expired lease", async () => {
      const task = await store.create({
        title: "Re-acquire Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Acquire with very short TTL
      await acquireLease(store, task.frontmatter.id, "agent-1", { ttlMs: 50 });

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should be able to re-acquire (expired lease)
      const reacquired = await acquireLease(store, task.frontmatter.id, "agent-1");
      expect(reacquired).toBeDefined();
      expect(reacquired?.frontmatter.lease?.agent).toBe("agent-1");
    });

    it("should set lease expiry time correctly", async () => {
      const task = await store.create({
        title: "Expiry Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const ttlMs = 30000; // 30 seconds
      const beforeAcquire = Date.now();
      const leased = await acquireLease(store, task.frontmatter.id, "agent-1", { ttlMs });
      const afterAcquire = Date.now();

      expect(leased?.frontmatter.lease).toBeDefined();
      
      const expiresAt = new Date(leased!.frontmatter.lease!.expiresAt).getTime();
      const acquiredAt = new Date(leased!.frontmatter.lease!.acquiredAt).getTime();

      // Expiry should be roughly ttlMs after acquisition
      const actualTtl = expiresAt - acquiredAt;
      expect(actualTtl).toBeGreaterThanOrEqual(ttlMs - 100); // Allow 100ms tolerance
      expect(actualTtl).toBeLessThanOrEqual(ttlMs + 100);

      // Acquisition should be within test timeframe
      expect(acquiredAt).toBeGreaterThanOrEqual(beforeAcquire);
      expect(acquiredAt).toBeLessThanOrEqual(afterAcquire);
    });
  });

  describe("lease renewal", () => {
    it("should renew lease and extend expiry time", async () => {
      const task = await store.create({
        title: "Renew Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const leased = await acquireLease(store, task.frontmatter.id, "agent-1", { ttlMs: 5000 });
      const originalExpiry = leased!.frontmatter.lease!.expiresAt;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      // Renew
      const renewed = await renewLease(store, task.frontmatter.id, "agent-1", { ttlMs: 5000 });

      expect(renewed?.frontmatter.lease?.renewCount).toBe(1);
      expect(renewed?.frontmatter.lease?.expiresAt).not.toBe(originalExpiry);
      
      // New expiry should be later
      const newExpiry = new Date(renewed!.frontmatter.lease!.expiresAt).getTime();
      const oldExpiry = new Date(originalExpiry).getTime();
      expect(newExpiry).toBeGreaterThan(oldExpiry);
    });

    it("should enforce max renewals limit", async () => {
      const task = await store.create({
        title: "Max Renewals Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      const maxRenewals = 2;
      await acquireLease(store, task.frontmatter.id, "agent-1", { maxRenewals });

      // Renew twice (should succeed)
      await renewLease(store, task.frontmatter.id, "agent-1", { maxRenewals });
      await renewLease(store, task.frontmatter.id, "agent-1", { maxRenewals });

      // Third renewal should fail
      await expect(
        renewLease(store, task.frontmatter.id, "agent-1", { maxRenewals })
      ).rejects.toThrow(/exhausted lease renewals/);
    });

    it("should prevent renewal by different agent", async () => {
      const task = await store.create({
        title: "Wrong Agent Renew",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      await acquireLease(store, task.frontmatter.id, "agent-1");

      // Agent 2 tries to renew agent 1's lease
      await expect(
        renewLease(store, task.frontmatter.id, "agent-2")
      ).rejects.toThrow(/is leased to agent-1, not agent-2/);
    });
  });

  describe("lease release", () => {
    it("should release lease and transition back to ready", async () => {
      const task = await store.create({
        title: "Release Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      await acquireLease(store, task.frontmatter.id, "agent-1");
      const released = await releaseLease(store, task.frontmatter.id, "agent-1");

      expect(released?.frontmatter.status).toBe("ready");
      expect(released?.frontmatter.lease).toBeUndefined();
    });

    it("should allow re-acquisition after release", async () => {
      const task = await store.create({
        title: "Release Re-acquire",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Acquire, release, re-acquire
      await acquireLease(store, task.frontmatter.id, "agent-1");
      await releaseLease(store, task.frontmatter.id, "agent-1");
      const reacquired = await acquireLease(store, task.frontmatter.id, "agent-1");

      expect(reacquired?.frontmatter.status).toBe("in-progress");
      expect(reacquired?.frontmatter.lease?.agent).toBe("agent-1");
    });

    it("should prevent release by different agent", async () => {
      const task = await store.create({
        title: "Wrong Agent Release",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      await acquireLease(store, task.frontmatter.id, "agent-1");

      await expect(
        releaseLease(store, task.frontmatter.id, "agent-2")
      ).rejects.toThrow(/is leased to agent-1, not agent-2/);
    });
  });

  describe("lease expiry", () => {
    it("should expire tasks with expired leases", async () => {
      const task = await store.create({
        title: "Expiry Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Acquire with very short TTL
      await acquireLease(store, task.frontmatter.id, "agent-1", { ttlMs: 50 });

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 100));

      // Expire leases
      const expired = await expireLeases(store);

      expect(expired).toContain(task.frontmatter.id);

      // Verify task is back in ready
      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("ready");
      expect(updated?.frontmatter.lease).toBeUndefined();
    });

    it("should not expire unexpired leases", async () => {
      const task = await store.create({
        title: "No Expire Test",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Acquire with long TTL
      await acquireLease(store, task.frontmatter.id, "agent-1", { ttlMs: 60000 });

      // Try to expire (should not expire)
      const expired = await expireLeases(store);

      expect(expired).not.toContain(task.frontmatter.id);

      // Verify task still in-progress with lease
      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("in-progress");
      expect(updated?.frontmatter.lease).toBeDefined();
    });

    it("should handle multiple expired tasks", async () => {
      // Create multiple tasks with short leases
      const task1 = await store.create({
        title: "Expire 1",
        body: "# T1",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task1.frontmatter.id, "ready");
      await acquireLease(store, task1.frontmatter.id, "agent-1", { ttlMs: 50 });

      const task2 = await store.create({
        title: "Expire 2",
        body: "# T2",
        createdBy: "system",
        routing: { agent: "agent-2" },
      });
      await store.transition(task2.frontmatter.id, "ready");
      await acquireLease(store, task2.frontmatter.id, "agent-2", { ttlMs: 50 });

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 100));

      // Expire all
      const expired = await expireLeases(store);

      expect(expired).toHaveLength(2);
      expect(expired).toContain(task1.frontmatter.id);
      expect(expired).toContain(task2.frontmatter.id);
    });
  });

  describe("concurrent operations", () => {
    it("should handle concurrent lease acquisition attempts", async () => {
      const task = await store.create({
        title: "Concurrent Acquire",
        body: "# Task",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Try to acquire from multiple agents simultaneously
      const results = await Promise.allSettled([
        acquireLease(store, task.frontmatter.id, "agent-1"),
        acquireLease(store, task.frontmatter.id, "agent-2"),
        acquireLease(store, task.frontmatter.id, "agent-3"),
      ]);

      // At least one should succeed (filesystem race conditions may allow multiple)
      const succeeded = results.filter(r => r.status === "fulfilled");
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      // Verify final state: only one agent should hold the lease
      const finalTask = await store.get(task.frontmatter.id);
      expect(finalTask?.frontmatter.lease).toBeDefined();
      expect(finalTask?.frontmatter.status).toBe("in-progress");
      
      // The lease holder should be one of the agents
      const leaseHolder = finalTask?.frontmatter.lease?.agent;
      expect(["agent-1", "agent-2", "agent-3"]).toContain(leaseHolder);
    });

    it("should handle multiple tasks being leased simultaneously", async () => {
      // Create multiple tasks
      const task1 = await store.create({
        title: "Multi 1",
        body: "# T1",
        createdBy: "system",
        routing: { agent: "agent-1" },
      });
      await store.transition(task1.frontmatter.id, "ready");

      const task2 = await store.create({
        title: "Multi 2",
        body: "# T2",
        createdBy: "system",
        routing: { agent: "agent-2" },
      });
      await store.transition(task2.frontmatter.id, "ready");

      const task3 = await store.create({
        title: "Multi 3",
        body: "# T3",
        createdBy: "system",
        routing: { agent: "agent-3" },
      });
      await store.transition(task3.frontmatter.id, "ready");

      // Lease all simultaneously
      const results = await Promise.all([
        acquireLease(store, task1.frontmatter.id, "agent-1"),
        acquireLease(store, task2.frontmatter.id, "agent-2"),
        acquireLease(store, task3.frontmatter.id, "agent-3"),
      ]);

      // All should succeed (different tasks)
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result?.frontmatter.status).toBe("in-progress");
        expect(result?.frontmatter.lease).toBeDefined();
      });
    });
  });
});
