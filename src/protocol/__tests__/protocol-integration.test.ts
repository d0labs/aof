import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { MockNotificationAdapter } from "../../events/notifier.js";
import { NotificationPolicyEngine, DEFAULT_RULES } from "../../events/notification-policy/index.js";
import { ProtocolRouter } from "../router.js";
import { readRunResult, writeRunResult } from "../../recovery/run-artifacts.js";
import type { ProtocolEnvelope } from "../../schemas/protocol.js";
import type { RunResult } from "../../schemas/run-result.js";
import type { Task } from "../../schemas/task.js";
import { acquireLease } from "../../store/lease.js";

/**
 * Integration test suite for AOF Protocols (TASK-057 through TASK-061)
 * 
 * These tests exercise the full protocol flows end-to-end using real
 * TaskStore instances with temporary directories. They validate the
 * complete lifecycle including:
 * - Protocol message routing
 * - State transitions
 * - Artifact writing (run_result.json, handoff.json, etc.)
 * - Event logging
 * - Notifications
 * - Recovery mechanisms (session_end)
 */
describe("Protocol Integration Tests", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;
  let adapter: MockNotificationAdapter;
  let router: ProtocolRouter;
  let loggedEvents: Array<{ type: string; actor: string; taskId?: string; payload?: Record<string, unknown> }>;

  beforeEach(async () => {
    // Create isolated test environment with real TaskStore
    tmpDir = await mkdtemp(join(tmpdir(), "aof-protocol-integration-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    
    adapter = new MockNotificationAdapter();
    const engine = new NotificationPolicyEngine(adapter, DEFAULT_RULES);

    loggedEvents = [];
    logger = new EventLogger(eventsDir, {
      onEvent: async (event) => {
        loggedEvents.push({
          type: event.type,
          actor: event.actor,
          taskId: event.taskId,
          payload: event.payload,
        });
        await engine.handleEvent(event);
      },
    });

    router = new ProtocolRouter({ store, logger });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Helper to create task in in-progress state
  const createInProgressTask = async (metadata?: Record<string, unknown>): Promise<Task> => {
    const task = await store.create({
      title: "Integration test task",
      createdBy: "swe-backend",
      metadata,
    });
    await store.transition(task.frontmatter.id, "ready");
    // Acquire lease for swe-backend agent
    const taskWithLease = await acquireLease(store, task.frontmatter.id, "swe-backend", { writeRunArtifacts: false });
    return taskWithLease!;
  };

  // Helper to build completion envelope
  const makeCompletionEnvelope = (
    taskId: string,
    outcome: "done" | "blocked" | "needs_review" | "partial",
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
      deliverables: ["src/implementation.ts", "src/__tests__/implementation.test.ts"],
      tests: { total: 10, passed: 10, failed: 0 },
      blockers: outcome === "blocked" ? ["Waiting for API key"] : [],
      notes: outcome === "done" ? "Implementation complete" : "Work in progress",
    },
  });

  describe("Full Completion Flow", () => {
    it("completes full lifecycle: dispatch → completion.report → run_result.json → session_end → final state", async () => {
      // Create and dispatch task
      const task = await createInProgressTask({ reviewRequired: true });
      
      // Agent sends completion.report
      const completionEnvelope = makeCompletionEnvelope(task.frontmatter.id, "done");
      await router.handleCompletionReport(completionEnvelope, store);

      // Verify run_result.json was written
      const runResult = await readRunResult(store, task.frontmatter.id);
      expect(runResult).toBeDefined();
      expect(runResult?.outcome).toBe("done");
      expect(runResult?.agentId).toBe("swe-backend");
      expect(runResult?.deliverables).toEqual(["src/implementation.ts", "src/__tests__/implementation.test.ts"]);
      expect(runResult?.tests).toEqual({ total: 10, passed: 10, failed: 0 });

      // Verify state transition to review
      let updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("review");

      // Verify events logged
      const messageReceived = loggedEvents.find(e => e.type === "protocol.message.received");
      expect(messageReceived).toBeDefined();
      expect(messageReceived?.actor).toBe("swe-backend");

      const taskCompleted = loggedEvents.find(e => e.type === "task.completed");
      expect(taskCompleted).toBeDefined();
      expect(taskCompleted?.payload?.outcome).toBe("done");

      const taskTransitioned = loggedEvents.find(e => e.type === "task.transitioned");
      expect(taskTransitioned).toBeDefined();
      expect(taskTransitioned?.payload?.from).toBe("in-progress");
      expect(taskTransitioned?.payload?.to).toBe("review");

      // Verify notification sent
      const notifications = adapter.sent.filter(n => n.message.includes("ready for review"));
      expect(notifications.length).toBeGreaterThan(0);

      // Simulate session_end (should be idempotent)
      await router.handleSessionEnd();

      // Verify state unchanged
      updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("review");
    });

    it("bypasses review when reviewRequired=false", async () => {
      const task = await createInProgressTask({ reviewRequired: false });
      
      await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "done"), store);

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("done");
    });

    it("transitions to blocked on blocked outcome", async () => {
      const task = await createInProgressTask();
      
      await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "blocked"), store);

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("blocked");

      const runResult = await readRunResult(store, task.frontmatter.id);
      expect(runResult?.outcome).toBe("blocked");
      expect(runResult?.blockers).toContain("Waiting for API key");
    });

    it("transitions to review on partial outcome", async () => {
      const task = await createInProgressTask();
      
      await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "partial"), store);

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("review");
    });
  });

  describe("Full Handoff Flow", () => {
    it("completes full handoff: parent creates child → handoff.request → artifacts written → handoff.accepted", async () => {
      // Parent creates child task
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

      // Architect sends handoff.request
      const handoffEnvelope: ProtocolEnvelope = {
        protocol: "aof",
        version: 1,
        type: "handoff.request",
        taskId: child.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          parentTaskId: parent.frontmatter.id,
          fromAgent: "architect",
          toAgent: "swe-backend",
          acceptanceCriteria: ["All tests pass", "Code reviewed"],
          expectedOutputs: ["Implementation", "Unit tests"],
          contextRefs: ["spec.md", "design.md"],
          constraints: ["No breaking changes", "Maintain backward compatibility"],
          dueBy: new Date(Date.now() + 86400000).toISOString(), // 24 hours
        },
      };

      await router.handleHandoffRequest(handoffEnvelope, store);

      // Verify handoff artifacts written
      const childDir = join(tmpDir, "tasks", "ready", child.frontmatter.id);
      const inputsDir = join(childDir, "inputs");
      const jsonPath = join(inputsDir, "handoff.json");
      const mdPath = join(inputsDir, "handoff.md");

      const jsonContent = await import("fs/promises").then(fs => fs.readFile(jsonPath, "utf-8"));
      const parsedJson = JSON.parse(jsonContent);
      expect(parsedJson.acceptanceCriteria).toEqual(["All tests pass", "Code reviewed"]);
      expect(parsedJson.expectedOutputs).toEqual(["Implementation", "Unit tests"]);

      const mdContent = await import("fs/promises").then(fs => fs.readFile(mdPath, "utf-8"));
      expect(mdContent).toContain("## Acceptance Criteria");
      expect(mdContent).toContain("All tests pass");
      expect(mdContent).toContain("## Expected Outputs");
      expect(mdContent).toContain("Implementation");

      // Verify delegationDepth set
      let updatedChild = await store.get(child.frontmatter.id);
      expect(updatedChild?.frontmatter.metadata?.delegationDepth).toBe(1);

      // Verify events logged
      const delegationRequested = loggedEvents.find(e => e.type === "delegation.requested");
      expect(delegationRequested).toBeDefined();
      expect(delegationRequested?.actor).toBe("architect");
      expect(delegationRequested?.taskId).toBe(child.frontmatter.id);

      // Transfer lease to target agent (swe-backend) for handoff.ack authorization
      await acquireLease(store, child.frontmatter.id, "swe-backend", { writeRunArtifacts: false });

      // Agent accepts handoff
      const acceptEnvelope: ProtocolEnvelope = {
        protocol: "aof",
        version: 1,
        type: "handoff.accepted",
        taskId: child.frontmatter.id,
        fromAgent: "swe-backend",
        toAgent: "architect",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          accepted: true,
        },
      };

      await router.handleHandoffAck(acceptEnvelope, store);

      // Verify state unchanged (in-progress after acquireLease)
      updatedChild = await store.get(child.frontmatter.id);
      expect(updatedChild?.frontmatter.status).toBe("in-progress");

      // Verify delegation.accepted logged
      const delegationAccepted = loggedEvents.find(e => e.type === "delegation.accepted");
      expect(delegationAccepted).toBeDefined();
      expect(delegationAccepted?.actor).toBe("swe-backend");
    });

    it("handles handoff rejection: handoff.rejected → child transitions to blocked", async () => {
      // Setup parent and child
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

      // Send handoff.request
      const handoffEnvelope: ProtocolEnvelope = {
        protocol: "aof",
        version: 1,
        type: "handoff.request",
        taskId: child.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          parentTaskId: parent.frontmatter.id,
          fromAgent: "architect",
          toAgent: "swe-backend",
          acceptanceCriteria: [],
          expectedOutputs: [],
          contextRefs: [],
          constraints: [],
        },
      };

      await router.handleHandoffRequest(handoffEnvelope, store);

      // Transfer lease to target agent (swe-backend) for handoff.ack authorization
      await acquireLease(store, child.frontmatter.id, "swe-backend", { writeRunArtifacts: false });

      // Agent rejects handoff
      const rejectEnvelope: ProtocolEnvelope = {
        protocol: "aof",
        version: 1,
        type: "handoff.rejected",
        taskId: child.frontmatter.id,
        fromAgent: "swe-backend",
        toAgent: "architect",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          accepted: false,
          reason: "Insufficient context provided",
        },
      };

      await router.handleHandoffAck(rejectEnvelope, store);

      // Verify state transition to blocked
      const updatedChild = await store.get(child.frontmatter.id);
      expect(updatedChild?.frontmatter.status).toBe("blocked");

      // Verify events logged (transition from in-progress after acquireLease)
      const taskTransitioned = loggedEvents.find(e => 
        e.type === "task.transitioned" && 
        e.taskId === child.frontmatter.id
      );
      expect(taskTransitioned).toBeDefined();
      expect(taskTransitioned?.payload?.from).toBe("in-progress");
      expect(taskTransitioned?.payload?.to).toBe("blocked");
      expect(taskTransitioned?.payload?.reason).toBe("Insufficient context provided");

      const delegationRejected = loggedEvents.find(e => e.type === "delegation.rejected");
      expect(delegationRejected).toBeDefined();
    });
  });

  describe("Stale Heartbeat Recovery Flow", () => {
    it("recovers from stale heartbeat: task in-progress → session_end reads run_result.json → applies correct transition", async () => {
      // Create task and simulate agent working on it
      const task = await createInProgressTask();

      // Agent writes run_result.json but crashes before sending completion.report
      const runResult: RunResult = {
        taskId: task.frontmatter.id,
        agentId: "swe-backend",
        completedAt: new Date().toISOString(),
        outcome: "done",
        summaryRef: "outputs/summary.md",
        handoffRef: "outputs/handoff.md",
        deliverables: ["src/recovered.ts"],
        tests: { total: 5, passed: 5, failed: 0 },
        blockers: [],
        notes: "Completed before crash",
      };

      await writeRunResult(store, task.frontmatter.id, runResult);

      // Verify task still in-progress
      let updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("in-progress");

      // Scheduler detects stale heartbeat and calls session_end
      await router.handleSessionEnd();

      // Verify task recovered to correct state
      updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("review");

      // Verify run_result.json still exists
      const recovered = await readRunResult(store, task.frontmatter.id);
      expect(recovered?.outcome).toBe("done");
    });

    it("recovers multiple tasks with different outcomes", async () => {
      // Create multiple tasks
      const task1 = await createInProgressTask({ reviewRequired: true });
      const task2 = await createInProgressTask({ reviewRequired: false });
      const task3 = await createInProgressTask();

      // Write different run_result.json for each
      await writeRunResult(store, task1.frontmatter.id, {
        taskId: task1.frontmatter.id,
        agentId: "swe-backend",
        completedAt: new Date().toISOString(),
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
        completedAt: new Date().toISOString(),
        outcome: "done",
        summaryRef: "outputs/summary.md",
        handoffRef: "outputs/handoff.md",
        deliverables: [],
        tests: { total: 1, passed: 1, failed: 0 },
        blockers: [],
        notes: "Complete",
      });

      await writeRunResult(store, task3.frontmatter.id, {
        taskId: task3.frontmatter.id,
        agentId: "swe-backend",
        completedAt: new Date().toISOString(),
        outcome: "blocked",
        summaryRef: "outputs/summary.md",
        handoffRef: "outputs/handoff.md",
        deliverables: [],
        tests: { total: 0, passed: 0, failed: 0 },
        blockers: ["Database unreachable"],
        notes: "Blocked",
      });

      // Run recovery
      await router.handleSessionEnd();

      // Verify each task in correct state
      const updated1 = await store.get(task1.frontmatter.id);
      const updated2 = await store.get(task2.frontmatter.id);
      const updated3 = await store.get(task3.frontmatter.id);

      expect(updated1?.frontmatter.status).toBe("review"); // reviewRequired: true
      expect(updated2?.frontmatter.status).toBe("done");    // reviewRequired: false
      expect(updated3?.frontmatter.status).toBe("blocked"); // blocked outcome
    });

    it("skips tasks without run_result.json", async () => {
      const task = await createInProgressTask();

      // No run_result.json written
      await router.handleSessionEnd();

      // Task should remain in-progress
      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("in-progress");
    });
  });

  describe("Error Flows", () => {
    it("rejects completion.report for non-existent task", async () => {
      const fakeTaskId = "TASK-9999-99-99-999";

      await router.handleCompletionReport(makeCompletionEnvelope(fakeTaskId, "done"), store);

      // Verify rejection logged
      const rejectedEvent = loggedEvents.find(
        e => e.type === "protocol.message.rejected" && e.taskId === fakeTaskId
      );
      expect(rejectedEvent).toBeDefined();
      expect(rejectedEvent?.payload?.reason).toBe("task_not_found");

      // Verify no run_result.json written
      const runResult = await readRunResult(store, fakeTaskId);
      expect(runResult).toBeUndefined();
    });

    it("rejects handoff.request with taskId mismatch", async () => {
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
        type: "handoff.request",
        taskId: child.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: "TASK-WRONG-ID", // Mismatch!
          parentTaskId: parent.frontmatter.id,
          fromAgent: "architect",
          toAgent: "swe-backend",
          acceptanceCriteria: [],
          expectedOutputs: [],
          contextRefs: [],
          constraints: [],
        },
      };

      await router.handleHandoffRequest(envelope, store);

      // Verify rejection logged
      const rejectedEvent = loggedEvents.find(
        e => e.type === "protocol.message.rejected"
      );
      expect(rejectedEvent).toBeDefined();
      expect(rejectedEvent?.payload?.reason).toBe("taskId_mismatch");
    });

    it("rejects handoff.request for missing parent task", async () => {
      const child = await store.create({
        title: "Child Task",
        createdBy: "architect",
        routing: { agent: "architect" },
      });
      await store.transition(child.frontmatter.id, "ready");

      const envelope: ProtocolEnvelope = {
        protocol: "aof",
        version: 1,
        type: "handoff.request",
        taskId: child.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          parentTaskId: "TASK-MISSING",
          fromAgent: "architect",
          toAgent: "swe-backend",
          acceptanceCriteria: [],
          expectedOutputs: [],
          contextRefs: [],
          constraints: [],
        },
      };

      await router.handleHandoffRequest(envelope, store);

      // Verify delegation rejection logged
      const rejectedEvent = loggedEvents.find(
        e => e.type === "delegation.rejected"
      );
      expect(rejectedEvent).toBeDefined();
      expect(rejectedEvent?.payload?.reason).toBe("parent_not_found");
    });

    it("rejects nested delegation (depth > 1)", async () => {
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
        type: "handoff.request",
        taskId: child.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          parentTaskId: parent.frontmatter.id,
          fromAgent: "architect",
          toAgent: "swe-backend",
          acceptanceCriteria: [],
          expectedOutputs: [],
          contextRefs: [],
          constraints: [],
        },
      };

      await router.handleHandoffRequest(envelope, store);

      // Verify rejection logged
      const rejectedEvent = loggedEvents.find(
        e => e.type === "delegation.rejected" && e.payload?.reason === "nested_delegation"
      );
      expect(rejectedEvent).toBeDefined();

      // Verify no handoff artifacts written
      const childDir = join(tmpDir, "tasks", "ready", child.frontmatter.id);
      const jsonPath = join(childDir, "inputs", "handoff.json");
      await expect(import("fs/promises").then(fs => fs.access(jsonPath))).rejects.toThrow();
    });

    it("rejects unauthorized handoff.request", async () => {
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

      // Unauthorized agent sends handoff.request
      const envelope: ProtocolEnvelope = {
        protocol: "aof",
        version: 1,
        type: "handoff.request",
        taskId: child.frontmatter.id,
        fromAgent: "rogue-agent",
        toAgent: "swe-backend",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          parentTaskId: parent.frontmatter.id,
          fromAgent: "rogue-agent",
          toAgent: "swe-backend",
          acceptanceCriteria: [],
          expectedOutputs: [],
          contextRefs: [],
          constraints: [],
        },
      };

      await router.handleHandoffRequest(envelope, store);

      // Verify rejection logged
      const rejectedEvent = loggedEvents.find(
        e => e.type === "protocol.message.rejected" && e.payload?.reason === "unauthorized_agent"
      );
      expect(rejectedEvent).toBeDefined();
      expect(rejectedEvent?.payload?.expected).toBe("architect");
      expect(rejectedEvent?.payload?.received).toBe("rogue-agent");

      // Verify no handoff artifacts written
      const childDir = join(tmpDir, "tasks", "ready", child.frontmatter.id);
      const jsonPath = join(childDir, "inputs", "handoff.json");
      await expect(import("fs/promises").then(fs => fs.access(jsonPath))).rejects.toThrow();
    });

    it("rejects unauthorized handoff.ack", async () => {
      const child = await store.create({
        title: "Child Task",
        createdBy: "architect",
        routing: { agent: "swe-backend" },
      });
      await store.transition(child.frontmatter.id, "ready");

      // Unauthorized agent sends handoff.rejected
      const envelope: ProtocolEnvelope = {
        protocol: "aof",
        version: 1,
        type: "handoff.rejected",
        taskId: child.frontmatter.id,
        fromAgent: "rogue-agent",
        toAgent: "architect",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          accepted: false,
          reason: "Malicious rejection",
        },
      };

      await router.handleHandoffAck(envelope, store);

      // Verify state unchanged (no transition to blocked)
      const updatedChild = await store.get(child.frontmatter.id);
      expect(updatedChild?.frontmatter.status).toBe("ready");

      // Verify rejection logged
      const rejectedEvent = loggedEvents.find(
        e => e.type === "protocol.message.rejected" && e.payload?.reason === "unauthorized_agent"
      );
      expect(rejectedEvent).toBeDefined();
      expect(rejectedEvent?.payload?.expected).toBe("swe-backend");
      expect(rejectedEvent?.payload?.received).toBe("rogue-agent");
    });
  });

  describe("Multi-Protocol Interaction", () => {
    it("handles completion + handoff in same task lifecycle", async () => {
      // Create parent and child
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

      // Step 1: Handoff request
      const handoffEnvelope: ProtocolEnvelope = {
        protocol: "aof",
        version: 1,
        type: "handoff.request",
        taskId: child.frontmatter.id,
        fromAgent: "architect",
        toAgent: "swe-backend",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          parentTaskId: parent.frontmatter.id,
          fromAgent: "architect",
          toAgent: "swe-backend",
          acceptanceCriteria: ["Tests pass"],
          expectedOutputs: ["Implementation"],
          contextRefs: [],
          constraints: [],
        },
      };

      await router.handleHandoffRequest(handoffEnvelope, store);

      // Transfer lease to target agent (swe-backend) for handoff.ack authorization
      await acquireLease(store, child.frontmatter.id, "swe-backend", { writeRunArtifacts: false });

      // Step 2: Handoff accepted
      await router.handleHandoffAck({
        protocol: "aof",
        version: 1,
        projectId: "test-project",
        type: "handoff.accepted",
        taskId: child.frontmatter.id,
        fromAgent: "swe-backend",
        toAgent: "architect",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: child.frontmatter.id,
          accepted: true,
        },
      }, store);

      // Step 3: Task already transitioned to in-progress by acquireLease
      // No need to transition again
      
      const completionEnvelope = makeCompletionEnvelope(child.frontmatter.id, "done");
      await router.handleCompletionReport(completionEnvelope, store);

      // Verify final state
      const updatedChild = await store.get(child.frontmatter.id);
      expect(updatedChild?.frontmatter.status).toBe("review");
      expect(updatedChild?.frontmatter.metadata?.delegationDepth).toBe(1);

      // Verify handoff artifacts still exist
      const childDir = join(tmpDir, "tasks", "review", child.frontmatter.id);
      const jsonPath = join(childDir, "inputs", "handoff.json");
      const jsonContent = await import("fs/promises").then(fs => fs.readFile(jsonPath, "utf-8"));
      expect(JSON.parse(jsonContent).acceptanceCriteria).toContain("Tests pass");

      // Verify run_result.json exists
      const runResult = await readRunResult(store, child.frontmatter.id);
      expect(runResult?.outcome).toBe("done");

      // Verify events logged in order
      const eventTypes = loggedEvents.map(e => e.type);
      expect(eventTypes).toContain("delegation.requested");
      expect(eventTypes).toContain("delegation.accepted");
      expect(eventTypes).toContain("task.completed");
    });

    it("handles status updates alongside completion flow", async () => {
      const task = await createInProgressTask();

      // Step 1: Status update (progress)
      await router.handleStatusUpdate({
        protocol: "aof",
        version: 1,
        projectId: "test-project",
        type: "status.update",
        taskId: task.frontmatter.id,
        fromAgent: "swe-backend",
        toAgent: "swe-qa",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: task.frontmatter.id,
          agentId: "swe-backend",
          progress: "Implemented 50% of features",
          notes: "On track",
        },
      }, store);

      // Verify work log appended
      let updated = await store.get(task.frontmatter.id);
      expect(updated?.body).toContain("Work Log");
      expect(updated?.body).toContain("Implemented 50% of features");

      // Step 2: Another status update (blocker)
      await router.handleStatusUpdate({
        protocol: "aof",
        version: 1,
        projectId: "test-project",
        type: "status.update",
        taskId: task.frontmatter.id,
        fromAgent: "swe-backend",
        toAgent: "swe-qa",
        sentAt: new Date().toISOString(),
        payload: {
          taskId: task.frontmatter.id,
          agentId: "swe-backend",
          status: "blocked",
          blockers: ["Waiting for design approval"],
        },
      }, store);

      // Verify transition to blocked
      updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("blocked");

      // Step 3: Unblock and complete (blocked → ready → in-progress)
      await store.transition(task.frontmatter.id, "ready");
      await acquireLease(store, task.frontmatter.id, "swe-backend", { writeRunArtifacts: false });
      await router.handleCompletionReport(makeCompletionEnvelope(task.frontmatter.id, "done"), store);

      // Verify final state
      updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("review");

      // Verify all events logged
      const transitionEvents = loggedEvents.filter(e => e.type === "task.transitioned");
      expect(transitionEvents.length).toBeGreaterThanOrEqual(2); // blocked + review
    });
  });
});
