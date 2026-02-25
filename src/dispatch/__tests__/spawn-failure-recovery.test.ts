import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import writeFileAtomic from "write-file-atomic";
import { FilesystemTaskStore, serializeTask } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { poll } from "../scheduler.js";
import { MockExecutor } from "../executor.js";
import {
  classifySpawnError,
  computeRetryBackoffMs,
  shouldAllowSpawnFailedRequeue,
  checkBlockedTaskRecovery,
  DEFAULT_MAX_DISPATCH_RETRIES,
} from "../scheduler-helpers.js";

describe("Spawn failure recovery", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-spawn-recovery-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- Unit tests for classifySpawnError ---

  describe("classifySpawnError", () => {
    it("classifies 'agent not found' as permanent", () => {
      expect(classifySpawnError("Agent not found: swe-backend")).toBe("permanent");
    });

    it("classifies 'agent_not_found' as permanent", () => {
      expect(classifySpawnError("error: agent_not_found")).toBe("permanent");
    });

    it("classifies 'no such agent' as permanent", () => {
      expect(classifySpawnError("No such agent registered")).toBe("permanent");
    });

    it("classifies 'agent deregistered' as permanent", () => {
      expect(classifySpawnError("agent deregistered during dispatch")).toBe("permanent");
    });

    it("classifies 'permission denied' as permanent", () => {
      expect(classifySpawnError("Permission denied for agent")).toBe("permanent");
    });

    it("classifies 'forbidden' as permanent", () => {
      expect(classifySpawnError("403 Forbidden")).toBe("permanent");
    });

    it("classifies 'unauthorized' as permanent", () => {
      expect(classifySpawnError("401 Unauthorized")).toBe("permanent");
    });

    it("classifies gateway timeout as transient", () => {
      expect(classifySpawnError("gateway timeout")).toBe("transient");
    });

    it("classifies connection refused as transient", () => {
      expect(classifySpawnError("ECONNREFUSED")).toBe("transient");
    });

    it("classifies rate limit as transient", () => {
      expect(classifySpawnError("429 Too Many Requests")).toBe("transient");
    });

    it("classifies unknown errors as transient", () => {
      expect(classifySpawnError("something went wrong")).toBe("transient");
    });
  });

  // --- Unit tests for computeRetryBackoffMs ---

  describe("computeRetryBackoffMs", () => {
    it("returns 60s for first retry (retryCount=0)", () => {
      expect(computeRetryBackoffMs(0)).toBe(60_000);
    });

    it("returns 180s for second retry (retryCount=1)", () => {
      expect(computeRetryBackoffMs(1)).toBe(180_000);
    });

    it("returns 540s for third retry (retryCount=2)", () => {
      expect(computeRetryBackoffMs(2)).toBe(540_000);
    });

    it("caps at 15 minutes", () => {
      expect(computeRetryBackoffMs(3)).toBe(900_000);
      expect(computeRetryBackoffMs(10)).toBe(900_000);
    });
  });

  // --- Unit tests for shouldAllowSpawnFailedRequeue ---

  describe("shouldAllowSpawnFailedRequeue", () => {
    function makeTask(overrides: Record<string, unknown> = {}) {
      return {
        frontmatter: {
          id: "test-task",
          title: "Test",
          status: "blocked" as const,
          priority: "medium",
          dependsOn: [],
          createdBy: "test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          routing: { agent: "swe-backend" },
          metadata: {
            retryCount: 0,
            blockReason: "spawn_failed: gateway timeout",
            lastBlockedAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
            ...overrides,
          },
        },
        body: "",
      } as any;
    }

    it("allows retry when retryCount < max and backoff elapsed", () => {
      const task = makeTask({ retryCount: 1, lastBlockedAt: new Date(Date.now() - 200_000).toISOString() });
      const result = shouldAllowSpawnFailedRequeue(task, 3);
      expect(result.allow).toBe(true);
    });

    it("denies retry when retryCount >= max, with shouldDeadletter", () => {
      const task = makeTask({ retryCount: 3 });
      const result = shouldAllowSpawnFailedRequeue(task, 3);
      expect(result.allow).toBe(false);
      expect(result.shouldDeadletter).toBe(true);
    });

    it("denies retry when backoff not elapsed", () => {
      // retryCount=1 needs 180s backoff, but only 10s have passed
      const task = makeTask({ retryCount: 1, lastBlockedAt: new Date(Date.now() - 10_000).toISOString() });
      const result = shouldAllowSpawnFailedRequeue(task, 3);
      expect(result.allow).toBe(false);
      expect(result.shouldDeadletter).toBe(false);
    });

    it("deadletters immediately for permanent errors", () => {
      const task = makeTask({ errorClass: "permanent", retryCount: 0 });
      const result = shouldAllowSpawnFailedRequeue(task, 3);
      expect(result.allow).toBe(false);
      expect(result.shouldDeadletter).toBe(true);
    });
  });

  // --- Integration tests for checkBlockedTaskRecovery ---

  describe("checkBlockedTaskRecovery", () => {
    function makeBlockedTask(id: string, metadata: Record<string, unknown>) {
      return {
        frontmatter: {
          id,
          title: `Task ${id}`,
          status: "blocked" as const,
          priority: "medium",
          dependsOn: [],
          createdBy: "test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          routing: { agent: "swe-backend" },
          metadata,
        },
        body: "",
      } as any;
    }

    it("emits deadletter when retryCount >= maxRetries", () => {
      const task = makeBlockedTask("t1", {
        retryCount: 3,
        blockReason: "spawn_failed: gateway error",
        lastBlockedAt: new Date(Date.now() - 600_000).toISOString(),
      });

      const actions = checkBlockedTaskRecovery([task], new Map(), 3);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.type).toBe("deadletter");
      expect(actions[0]!.taskId).toBe("t1");
    });

    it("emits requeue when retryCount < maxRetries and backoff elapsed", () => {
      const task = makeBlockedTask("t2", {
        retryCount: 0,
        blockReason: "spawn_failed: connection refused",
        lastBlockedAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago, backoff for retry 0 is 60s
      });

      const actions = checkBlockedTaskRecovery([task], new Map(), 3);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.type).toBe("requeue");
    });

    it("emits nothing when backoff not elapsed", () => {
      const task = makeBlockedTask("t3", {
        retryCount: 1,
        blockReason: "spawn_failed: timeout",
        lastBlockedAt: new Date(Date.now() - 5_000).toISOString(), // 5s ago, needs 180s
      });

      const actions = checkBlockedTaskRecovery([task], new Map(), 3);
      expect(actions).toHaveLength(0);
    });

    it("deadletters permanently-classified errors immediately", () => {
      const task = makeBlockedTask("t4", {
        retryCount: 0,
        blockReason: "spawn_failed: agent not found",
        errorClass: "permanent",
        lastBlockedAt: new Date().toISOString(),
      });

      const actions = checkBlockedTaskRecovery([task], new Map(), 3);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.type).toBe("deadletter");
    });
  });

  // --- End-to-end: no infinite loop ---

  describe("end-to-end: no infinite retry loop", () => {
    it("task reaches deadletter after exactly maxRetries via scheduler poll", async () => {
      const executor = new MockExecutor();
      executor.setShouldFail(true, "gateway timeout");

      const activeConfig = {
        dataDir: tmpDir,
        dryRun: false,
        defaultLeaseTtlMs: 600_000,
        executor,
        maxDispatchRetries: 3,
      };

      // Create a task and move to ready
      const task = await store.create({
        title: "Retry test task",
        createdBy: "main",
        routing: { agent: "swe-backend" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Helper to backdate lastBlockedAt so backoff is elapsed
      async function backdateBlocked(ms: number) {
        const t = await store.get(task.frontmatter.id);
        if (t) {
          t.frontmatter.metadata = {
            ...t.frontmatter.metadata,
            lastBlockedAt: new Date(Date.now() - ms).toISOString(),
          };
          const tp = t.path ?? join(store.tasksDir, "blocked", `${t.frontmatter.id}.md`);
          await writeFileAtomic(tp, serializeTask(t));
        }
      }

      // Poll 1: dispatch → spawn fails → blocked (retryCount=1)
      await poll(store, logger, activeConfig);
      let current = await store.get(task.frontmatter.id);
      expect(current?.frontmatter.status).toBe("blocked");
      expect(current?.frontmatter.metadata?.retryCount).toBe(1);

      // Backdate (retryCount=1 needs 180s backoff)
      await backdateBlocked(200_000);

      // Poll 2: recovery requeues → ready
      await poll(store, logger, activeConfig);
      current = await store.get(task.frontmatter.id);
      expect(current?.frontmatter.status).toBe("ready");

      // Poll 3: dispatch → spawn fails → blocked (retryCount=2)
      await poll(store, logger, activeConfig);
      current = await store.get(task.frontmatter.id);
      expect(current?.frontmatter.status).toBe("blocked");
      expect(current?.frontmatter.metadata?.retryCount).toBe(2);

      // Backdate (retryCount=2 needs 540s backoff)
      await backdateBlocked(600_000);

      // Poll 4: recovery requeues → ready
      await poll(store, logger, activeConfig);
      current = await store.get(task.frontmatter.id);
      expect(current?.frontmatter.status).toBe("ready");

      // Poll 5: dispatch → spawn fails → blocked (retryCount=3)
      await poll(store, logger, activeConfig);
      current = await store.get(task.frontmatter.id);
      expect(current?.frontmatter.status).toBe("blocked");
      expect(current?.frontmatter.metadata?.retryCount).toBe(3);

      // Poll 6: recovery detects maxRetries (3 >= 3) → deadletter
      await poll(store, logger, activeConfig);
      current = await store.get(task.frontmatter.id);
      expect(current?.frontmatter.status).toBe("deadletter");
    });

    it("permanent spawn error deadletters immediately on first attempt", async () => {
      const executor = new MockExecutor();
      executor.setShouldFail(true, "Agent not found: nonexistent-agent");

      const activeConfig = {
        dataDir: tmpDir,
        dryRun: false,
        defaultLeaseTtlMs: 600_000,
        executor,
        maxDispatchRetries: 3,
      };

      const task = await store.create({
        title: "Permanent failure task",
        createdBy: "main",
        routing: { agent: "nonexistent-agent" },
      });
      await store.transition(task.frontmatter.id, "ready");

      // Single poll → permanent error → deadletter immediately
      await poll(store, logger, activeConfig);
      const current = await store.get(task.frontmatter.id);
      expect(current?.frontmatter.status).toBe("deadletter");
    });
  });
});
