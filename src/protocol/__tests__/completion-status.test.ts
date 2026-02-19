import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { MockNotificationAdapter, NotificationService } from "../../events/notifier.js";
import { ProtocolRouter } from "../router.js";
import { readRunResult, writeRunResult } from "../../recovery/run-artifacts.js";
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
  sentAt: "2026-02-09T21:10:00.000Z",
  payload: {
    outcome,
    summaryRef: "outputs/summary.md",
    deliverables: ["src/foo.ts"],
    tests: { total: 1, passed: 1, failed: 0 },
    blockers: outcome === "blocked" ? ["Awaiting API key"] : [],
    notes: "Implemented core logic",
  },
  ...overrides,
});

const makeStatusEnvelope = (taskId: string, payload: ProtocolEnvelope["payload"]): ProtocolEnvelope => ({
  protocol: "aof",
  version: 1,
  projectId: "test-project",
  type: "status.update",
  taskId,
  fromAgent: "swe-backend",
  toAgent: "swe-qa",
  sentAt: "2026-02-09T21:05:00.000Z",
  payload,
});

describe("ProtocolRouter completion/status handlers", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let adapter: MockNotificationAdapter;
  let notifier: NotificationService;
  let router: ProtocolRouter;
  let loggedEvents: Array<{ type: string; actor: string; taskId?: string; payload?: Record<string, unknown> }>;

  const createInProgressTask = async (metadata?: Record<string, unknown>) => {
    const task = await store.create({
      title: "Protocol task",
      createdBy: "main",
      metadata,
    });
    await store.transition(task.frontmatter.id, "ready");
    // Acquire lease for swe-backend agent
    const taskWithLease = await acquireLease(store, task.frontmatter.id, "swe-backend", { writeRunArtifacts: false });
    return taskWithLease!;
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-protocol-handler-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    
    loggedEvents = [];
    logger = new EventLogger(eventsDir, {
      onEvent: (event) => {
        loggedEvents.push({
          type: event.type,
          actor: event.actor,
          taskId: event.taskId,
          payload: event.payload,
        });
      },
    });

    adapter = new MockNotificationAdapter();
    notifier = new NotificationService(adapter, { enabled: true });
    router = new ProtocolRouter({ store, logger, notifier });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes run_result.json and moves done outcomes to review", async () => {
    const task = await createInProgressTask();

    await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "done"), store);

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("review");

    const runResult = await readRunResult(store, task.frontmatter.id);
    expect(runResult?.outcome).toBe("done");
    expect(runResult?.handoffRef).toBe("outputs/handoff.md");

    const reviewNotifications = adapter.sent.filter((entry) => entry.message.includes("ready for review"));
    expect(reviewNotifications.length).toBeGreaterThan(0);
  });

  it("moves done outcomes to done when review is not required", async () => {
    const task = await createInProgressTask({ reviewRequired: false });

    await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "done"), store);

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("done");
  });

  it("moves blocked outcomes to blocked", async () => {
    const task = await createInProgressTask();

    await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "blocked"), store);

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("blocked");
  });

  it.each(["needs_review", "partial"] as const)("moves %s outcomes to review", async (outcome) => {
    const task = await createInProgressTask();

    await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, outcome), store);

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("review");
  });

  it("is idempotent when completion outcome already applied", async () => {
    const task = await createInProgressTask();
    await store.transition(task.frontmatter.id, "review");
    const before = await store.get(task.frontmatter.id);

    await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "needs_review"), store);

    const after = await store.get(task.frontmatter.id);
    expect(after?.frontmatter.status).toBe("review");
    expect(after?.frontmatter.lastTransitionAt).toBe(before?.frontmatter.lastTransitionAt);
  });

  it("transitions when status update includes status", async () => {
    const task = await createInProgressTask();

    await router.handleStatusUpdate(
      makeStatusEnvelope(task.frontmatter.id, {
        taskId: task.frontmatter.id,
        agentId: "swe-backend",
        status: "blocked",
        progress: "Waiting on API key",
        blockers: ["API key pending"],
        notes: "ETA tomorrow",
      }),
      store,
    );

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("blocked");
  });

  it("appends work log entries when status update has only progress", async () => {
    const task = await createInProgressTask();

    await router.handleStatusUpdate(
      makeStatusEnvelope(task.frontmatter.id, {
        taskId: task.frontmatter.id,
        agentId: "swe-backend",
        progress: "Implemented routing logic",
        notes: "Need QA review",
      }),
      store,
    );

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("in-progress");
    expect(updated?.body).toContain("Work Log");
    expect(updated?.body).toContain("Implemented routing logic");
    expect(updated?.body).toContain("Need QA review");
  });

  it("reconciles run_result.json on session end", async () => {
    const task = await createInProgressTask();

    await writeRunResult(store, task.frontmatter.id, {
      taskId: task.frontmatter.id,
      agentId: "swe-backend",
      completedAt: "2026-02-09T21:10:00.000Z",
      outcome: "partial",
      summaryRef: "outputs/summary.md",
      handoffRef: "outputs/handoff.md",
      deliverables: [],
      tests: { total: 1, passed: 1, failed: 0 },
      blockers: [],
      notes: "Work in progress",
    });

    await router.handleSessionEnd();

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("review");
  });

  it("logs protocol.message.received on completion.report", async () => {
    const task = await createInProgressTask();

    await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "done"), store);

    const completionEvent = loggedEvents.find(
      (e) => e.type === "protocol.message.received" && e.taskId === task.frontmatter.id
    );
    expect(completionEvent).toBeDefined();
    expect(completionEvent?.actor).toBe("swe-backend");
    expect(completionEvent?.payload?.type).toBe("completion.report");
  });

  it("logs task.completed on completion.report", async () => {
    const task = await createInProgressTask();

    await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "done"), store);

    const completedEvent = loggedEvents.find(
      (e) => e.type === "task.completed" && e.taskId === task.frontmatter.id
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.actor).toBe("swe-backend");
    expect(completedEvent?.payload?.outcome).toBe("done");
  });

  it("rejects completion.report for non-existent task", async () => {
    const fakeTaskId = "TASK-9999-99-99-999";

    await router.handleCompletionReport(makeCompletionEnvelope(fakeTaskId, "done"), store);

    const rejectedEvent = loggedEvents.find(
      (e) => e.type === "protocol.message.rejected" && e.taskId === fakeTaskId
    );
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent?.payload?.reason).toBe("task_not_found");
  });

  it("is idempotent when blocked outcome already applied", async () => {
    const task = await createInProgressTask();
    await store.transition(task.frontmatter.id, "blocked");
    const before = await store.get(task.frontmatter.id);

    await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "blocked"), store);

    const after = await store.get(task.frontmatter.id);
    expect(after?.frontmatter.status).toBe("blocked");
    expect(after?.frontmatter.lastTransitionAt).toBe(before?.frontmatter.lastTransitionAt);
  });

  it("session_end reconciles multiple tasks with run_result.json", async () => {
    const task1 = await createInProgressTask();
    const task2 = await createInProgressTask();

    await writeRunResult(store, task1.frontmatter.id, {
      taskId: task1.frontmatter.id,
      agentId: "swe-backend",
      completedAt: "2026-02-09T21:10:00.000Z",
      outcome: "done",
      summaryRef: "outputs/summary.md",
      handoffRef: "outputs/handoff.md",
      deliverables: [],
      tests: { total: 1, passed: 1, failed: 0 },
      blockers: [],
      notes: "Complete",
    });

    await writeRunResult(store, task2.frontmatter.id, {
      taskId: task2.frontmatter.id,
      agentId: "swe-backend",
      completedAt: "2026-02-09T21:15:00.000Z",
      outcome: "blocked",
      summaryRef: "outputs/summary.md",
      handoffRef: "outputs/handoff.md",
      deliverables: [],
      tests: { total: 0, passed: 0, failed: 0 },
      blockers: ["API key missing"],
      notes: "Blocked",
    });

    await router.handleSessionEnd();

    const updated1 = await store.get(task1.frontmatter.id);
    const updated2 = await store.get(task2.frontmatter.id);
    expect(updated1?.frontmatter.status).toBe("review");
    expect(updated2?.frontmatter.status).toBe("blocked");
  });

  it("session_end skips tasks without run_result.json", async () => {
    const task1 = await createInProgressTask();
    const task2 = await createInProgressTask();

    await writeRunResult(store, task1.frontmatter.id, {
      taskId: task1.frontmatter.id,
      agentId: "swe-backend",
      completedAt: "2026-02-09T21:10:00.000Z",
      outcome: "done",
      summaryRef: "outputs/summary.md",
      handoffRef: "outputs/handoff.md",
      deliverables: [],
      tests: { total: 1, passed: 1, failed: 0 },
      blockers: [],
      notes: "Complete",
    });

    await router.handleSessionEnd();

    const updated1 = await store.get(task1.frontmatter.id);
    const updated2 = await store.get(task2.frontmatter.id);
    expect(updated1?.frontmatter.status).toBe("review");
    expect(updated2?.frontmatter.status).toBe("in-progress");
  });

  it("rejects completion report from unauthorized agent", async () => {
    const task = await createInProgressTask();
    const unauthorizedEnvelope = makeCompletionEnvelope(task.frontmatter.id, "done", { fromAgent: "rogue-agent" });

    await router.handleCompletionReport(unauthorizedEnvelope, store);

    // Verify state unchanged
    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("in-progress");

    // Verify no run_result.json written
    const runResult = await readRunResult(store, task.frontmatter.id);
    expect(runResult).toBeUndefined();

    // Verify rejection logged
    const rejectedEvent = loggedEvents.find(
      (e) => e.type === "protocol.message.rejected" && e.payload?.reason === "unauthorized_agent"
    );
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent?.payload?.expected).toBe("swe-backend");
    expect(rejectedEvent?.payload?.received).toBe("rogue-agent");
  });

  it("rejects completion report for unassigned task", async () => {
    // Create task without lease
    const task = await store.create({
      title: "Unassigned task",
      createdBy: "main",
    });
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");

    await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "done"), store);

    // Verify state unchanged
    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("in-progress");

    // Verify no run_result.json written
    const runResult = await readRunResult(store, task.frontmatter.id);
    expect(runResult).toBeUndefined();

    // Verify rejection logged
    const rejectedEvent = loggedEvents.find(
      (e) => e.type === "protocol.message.rejected" && e.payload?.reason === "unassigned_task"
    );
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent?.payload?.sender).toBe("swe-backend");
  });

  it("logs warning when summaryRef file does not exist", async () => {
    const task = await createInProgressTask();
    const envelope = makeCompletionEnvelope(task.frontmatter.id, "done", {
      payload: {
        outcome: "done",
        summaryRef: "outputs/nonexistent-summary.md",
        deliverables: [],
        tests: { total: 1, passed: 1, failed: 0 },
        blockers: [],
        notes: "Test",
      },
    });

    await router.handleCompletionReport(envelope, store);

    // Completion still proceeds despite missing file
    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.status).toBe("review");

    // Warning logged
    const warningEvent = loggedEvents.find(
      (e) => e.type === "protocol.message.warning" && e.payload?.reason === "summary_file_not_found",
    );
    expect(warningEvent).toBeDefined();
    expect(warningEvent?.payload?.summaryRef).toBe("outputs/nonexistent-summary.md");
  });

  it("does not log warning when summaryRef file exists", async () => {
    const task = await createInProgressTask();

    // Create the summary file
    const summaryPath = join(tmpDir, "summary.md");
    await writeFile(summaryPath, "# Summary\nDone.");

    const envelope = makeCompletionEnvelope(task.frontmatter.id, "done", {
      payload: {
        outcome: "done",
        summaryRef: summaryPath,
        deliverables: [],
        tests: { total: 1, passed: 1, failed: 0 },
        blockers: [],
        notes: "Test",
      },
    });

    await router.handleCompletionReport(envelope, store);

    // No warning logged
    const warningEvent = loggedEvents.find(
      (e) => e.type === "protocol.message.warning" && e.payload?.reason === "summary_file_not_found",
    );
    expect(warningEvent).toBeUndefined();
  });
});
