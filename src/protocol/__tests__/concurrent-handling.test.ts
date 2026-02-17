import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { MockNotificationAdapter, NotificationService } from "../../events/notifier.js";
import { ProtocolRouter } from "../router.js";
import { readRunResult } from "../../recovery/run-artifacts.js";
import type { ProtocolEnvelope } from "../../schemas/protocol.js";
import { acquireLease } from "../../store/lease.js";

const makeCompletionEnvelope = (
  taskId: string,
  outcome: "done" | "blocked" | "needs_review" | "partial",
  overrides: Partial<ProtocolEnvelope> = {},
): ProtocolEnvelope => ({
  protocol: "aof",
  version: 1,
  projectId: "test-project",
  type: "completion.report",
  taskId,
  fromAgent: "swe-backend",
  toAgent: "swe-qa",
  sentAt: new Date().toISOString(),
  payload: {
    outcome,
    summaryRef: "outputs/summary.md",
    deliverables: ["src/foo.ts"],
    tests: { total: 1, passed: 1, failed: 0 },
    blockers: outcome === "blocked" ? ["Awaiting API key"] : [],
    notes: `Completion with outcome: ${outcome}`,
  },
  ...overrides,
});

const makeStatusEnvelope = (taskId: string, notes: string): ProtocolEnvelope => ({
  protocol: "aof",
  version: 1,
  projectId: "test-project",
  type: "status.update",
  taskId,
  fromAgent: "swe-backend",
  toAgent: "swe-qa",
  sentAt: new Date().toISOString(),
  payload: {
    taskId,
    agentId: "swe-backend",
    progress: notes,
    notes,
  },
});

describe("Concurrent protocol message handling", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let adapter: MockNotificationAdapter;
  let notifier: NotificationService;
  let router: ProtocolRouter;

  const createInProgressTask = async () => {
    const task = await store.create({
      title: "Concurrent test task",
      createdBy: "main",
    });
    await store.transition(task.frontmatter.id, "ready");
    const taskWithLease = await acquireLease(store, task.frontmatter.id, "swe-backend", { writeRunArtifacts: false });
    return taskWithLease!;
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-concurrent-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);

    adapter = new MockNotificationAdapter();
    notifier = new NotificationService(adapter, { enabled: true });
    router = new ProtocolRouter({ store, logger, notifier });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("serializes concurrent completion reports for the same task", async () => {
    const task = await createInProgressTask();
    const taskId = task.frontmatter.id;

    // Send two concurrent completion reports with different outcomes
    const envelope1 = makeCompletionEnvelope(taskId, "done", {
      sentAt: "2026-02-10T19:00:00.000Z",
      payload: {
        outcome: "done",
        summaryRef: "outputs/summary.md",
        deliverables: ["file1.ts"],
        tests: { total: 10, passed: 10, failed: 0 },
        notes: "First completion",
      },
    });

    const envelope2 = makeCompletionEnvelope(taskId, "needs_review", {
      sentAt: "2026-02-10T19:00:01.000Z",
      payload: {
        outcome: "needs_review",
        summaryRef: "outputs/summary2.md",
        deliverables: ["file2.ts"],
        tests: { total: 5, passed: 5, failed: 0 },
        notes: "Second completion",
      },
    });

    // Execute concurrently
    await Promise.all([
      router.route(envelope1),
      router.route(envelope2),
    ]);

    // Verify final state is stable (last write wins based on serial execution)
    const runResult = await readRunResult(store, taskId);
    expect(runResult).toBeDefined();
    expect(runResult?.outcome).toBeDefined();
    expect(runResult?.notes).toBeDefined();
    
    // Verify task transitioned properly
    const finalTask = await store.get(taskId);
    expect(finalTask?.frontmatter.status).toMatch(/^(review|done)$/);
  });

  it("allows concurrent processing of different tasks", async () => {
    const task1 = await createInProgressTask();
    const task2 = await createInProgressTask();

    const startTime = Date.now();
    
    // Execute concurrently for different tasks
    await Promise.all([
      router.route(makeCompletionEnvelope(task1.frontmatter.id, "done")),
      router.route(makeCompletionEnvelope(task2.frontmatter.id, "done")),
    ]);

    const elapsed = Date.now() - startTime;

    // Both should complete
    const result1 = await readRunResult(store, task1.frontmatter.id);
    const result2 = await readRunResult(store, task2.frontmatter.id);
    
    expect(result1?.outcome).toBe("done");
    expect(result2?.outcome).toBe("done");

    // Should be fast (concurrent execution, not waiting for each other)
    expect(elapsed).toBeLessThan(1000);
  });

  it("serializes concurrent status updates for the same task", async () => {
    const task = await createInProgressTask();
    const taskId = task.frontmatter.id;

    const updates: string[] = [];
    const promises = [];

    // Send multiple concurrent status updates
    for (let i = 0; i < 5; i++) {
      const envelope = makeStatusEnvelope(taskId, `Update ${i}`);
      promises.push(router.route(envelope).then(() => {
        updates.push(`Update ${i}`);
      }));
    }

    await Promise.all(promises);

    // All updates should have been processed
    expect(updates).toHaveLength(5);
    
    // Task should still be in valid state
    const finalTask = await store.get(taskId);
    expect(finalTask?.frontmatter.status).toBe("in-progress");
  });

  it("handles errors during concurrent processing without blocking", async () => {
    const task = await createInProgressTask();
    const taskId = task.frontmatter.id;

    // First envelope will succeed
    const envelope1 = makeCompletionEnvelope(taskId, "done");
    
    // Second envelope has invalid taskId in route but valid in completion
    const envelope2 = makeCompletionEnvelope("NONEXISTENT-TASK", "done");

    // Execute concurrently
    await Promise.all([
      router.route(envelope1),
      router.route(envelope2),
    ]);

    // First should succeed
    const result = await readRunResult(store, taskId);
    expect(result?.outcome).toBe("done");
  });

  it("maintains artifact consistency under concurrent completion reports", async () => {
    const task = await createInProgressTask();
    const taskId = task.frontmatter.id;

    // Create multiple completion reports with unique deliverables
    const envelopes = Array.from({ length: 10 }, (_, i) =>
      makeCompletionEnvelope(taskId, "done", {
        payload: {
          outcome: "done",
          summaryRef: `outputs/summary-${i}.md`,
          deliverables: [`file-${i}.ts`],
          tests: { total: i, passed: i, failed: 0 },
          notes: `Completion ${i}`,
        },
      })
    );

    // Execute all concurrently
    await Promise.all(envelopes.map((env) => router.route(env)));

    // Verify run_result is consistent (one complete report, not corrupted)
    const runResult = await readRunResult(store, taskId);
    expect(runResult).toBeDefined();
    expect(runResult?.outcome).toBe("done");
    expect(runResult?.deliverables).toHaveLength(1);
    expect(runResult?.deliverables?.[0]).toMatch(/^file-\d+\.ts$/);
    expect(runResult?.notes).toMatch(/^Completion \d+$/);
  });
});
