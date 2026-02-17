import type { ProtocolEnvelope as ProtocolEnvelopeType } from "../schemas/protocol.js";
import type { StatusUpdatePayload } from "../schemas/protocol.js";
import type { HandoffRequestPayload, HandoffAckPayload } from "../schemas/protocol.js";
import type { Task } from "../schemas/task.js";
import { isValidTransition } from "../schemas/task.js";
import type { TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import { serializeTask } from "../store/task-store.js";
import type { NotificationService } from "../events/notifier.js";
import { readRunResult, writeRunResult } from "../recovery/run-artifacts.js";
import type { RunResult } from "../schemas/run-result.js";
import { writeHandoffArtifacts } from "../delegation/index.js";
import { resolveCompletionTransitions } from "./completion-utils.js";
import writeFileAtomic from "write-file-atomic";
import type { TaskLockManager } from "./task-lock.js";
import { InMemoryTaskLockManager } from "./task-lock.js";
import { parseProtocolMessage, type ProtocolLogger } from "./parsers.js";
import { buildCompletionReason, buildStatusReason, shouldAppendWorkLog, buildWorkLogEntry, appendSection } from "./formatters.js";

// Re-export for backward compatibility
export { parseProtocolMessage } from "./parsers.js";
export type { ProtocolLogger } from "./parsers.js";

export interface ProtocolRouterDependencies {
  store: ITaskStore;
  logger?: ProtocolLogger;
  notifier?: NotificationService;
  lockManager?: TaskLockManager;
  projectStoreResolver?: (projectId: string) => TaskStore | undefined;
}

export class ProtocolRouter {
  private readonly handlers: Record<
    string,
    (envelope: ProtocolEnvelopeType, store: ITaskStore) => Promise<void> | void
  >;
  private readonly logger?: ProtocolLogger;
  private readonly store: ITaskStore;
  private readonly notifier?: NotificationService;
  private readonly lockManager: TaskLockManager;
  private readonly projectStoreResolver?: (projectId: string) => TaskStore | undefined;

  constructor(deps: ProtocolRouterDependencies) {
    this.logger = deps.logger;
    this.store = deps.store;
    this.notifier = deps.notifier;
    this.lockManager = deps.lockManager ?? new InMemoryTaskLockManager();
    this.projectStoreResolver = deps.projectStoreResolver;
    this.handlers = {
      "completion.report": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleCompletionReport(envelope, store)),
      "status.update": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleStatusUpdate(envelope, store)),
      "handoff.request": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleHandoffRequest(envelope, store)),
      "handoff.accepted": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleHandoffAck(envelope, store)),
      "handoff.rejected": (envelope, store) =>
        this.lockManager.withLock(envelope.taskId, () => this.handleHandoffAck(envelope, store)),
    };
  }

  async route(envelope: ProtocolEnvelopeType): Promise<void> {
    const handler = this.handlers[envelope.type];
    if (!handler) {
      await this.logger?.log("protocol.message.unknown", "system", {
        taskId: envelope.taskId,
        payload: { type: envelope.type },
      });
      return;
    }

    // Validate project and resolve store
    const store = this.resolveProjectStore(envelope.projectId);
    if (!store) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: {
          reason: "invalid_project_id",
          projectId: envelope.projectId,
        },
      });
      return;
    }

    // Validate task exists in the project
    const task = await store.get(envelope.taskId);
    if (!task) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: {
          reason: "task_not_found",
          projectId: envelope.projectId,
        },
      });
      return;
    }

    await handler(envelope, store);
  }

  private resolveProjectStore(projectId: string): TaskStore | undefined {
    if (this.projectStoreResolver) {
      return this.projectStoreResolver(projectId);
    }
    // Fallback for legacy single-store mode
    return this.store;
  }

  async handleCompletionReport(
    envelope: ProtocolEnvelopeType,
    store: ITaskStore,
  ): Promise<void> {
    await this.logger?.log("protocol.message.received", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { type: envelope.type },
    });

    if (envelope.type !== "completion.report") return;

    const task = await store.get(envelope.taskId);
    if (!task) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      return;
    }

    // Authorization check: only assigned agent can send completion reports
    if (!(await this.checkAuthorization(envelope, task))) {
      return;
    }

    const runResult: RunResult = {
      taskId: envelope.taskId,
      agentId: envelope.fromAgent,
      completedAt: envelope.sentAt,
      outcome: envelope.payload.outcome,
      summaryRef: envelope.payload.summaryRef,
      handoffRef: "outputs/handoff.md",
      deliverables: envelope.payload.deliverables,
      tests: envelope.payload.tests,
      blockers: envelope.payload.blockers,
      notes: envelope.payload.notes,
    };

    await writeRunResult(store, envelope.taskId, runResult);

    await this.applyCompletionOutcome(
      task,
      {
        actor: envelope.fromAgent,
        outcome: envelope.payload.outcome,
        notes: envelope.payload.notes,
        blockers: envelope.payload.blockers,
      },
      store,
    );

    await this.logger?.log("task.completed", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { outcome: envelope.payload.outcome },
    });
  }

  async handleStatusUpdate(
    envelope: ProtocolEnvelopeType,
    store: ITaskStore,
  ): Promise<void> {
    await this.logger?.log("protocol.message.received", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { type: envelope.type },
    });

    if (envelope.type !== "status.update") return;

    const task = await store.get(envelope.taskId);
    if (!task) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      return;
    }

    const actor = envelope.payload.agentId ?? envelope.fromAgent;
    const reason = buildStatusReason(envelope.payload);

    let updatedTask = task;
    let transitioned = false;

    if (envelope.payload.status) {
      const targetStatus = envelope.payload.status;
      if (updatedTask.frontmatter.status !== targetStatus) {
        const nextTask = await this.transitionTask(
          updatedTask,
          targetStatus,
          actor,
          reason,
          store,
        );
        transitioned = nextTask.frontmatter.status !== updatedTask.frontmatter.status;
        updatedTask = nextTask;
      }
    }

    if (!transitioned && shouldAppendWorkLog(envelope.payload)) {
      updatedTask = await this.appendWorkLog(updatedTask, envelope.payload, store);
    }

    if (transitioned) {
      await this.logTransition(
        updatedTask.frontmatter.id,
        task.frontmatter.status,
        updatedTask.frontmatter.status,
        actor,
        reason,
      );
      await this.notifyTransition(
        updatedTask.frontmatter.id,
        task.frontmatter.status,
        updatedTask.frontmatter.status,
        actor,
        reason,
      );
    }
  }

  async handleSessionEnd(): Promise<void> {
    const inProgress = await this.store.list({ status: "in-progress" });
    for (const task of inProgress) {
      const runResult = await readRunResult(this.store, task.frontmatter.id);
      if (!runResult) continue;
      await this.applyCompletionOutcome(
        task,
        {
          actor: runResult.agentId,
          outcome: runResult.outcome,
          notes: runResult.notes,
          blockers: runResult.blockers,
        },
        this.store,
      );
    }
  }

  async handleHandoffRequest(
    envelope: ProtocolEnvelopeType,
    store: ITaskStore,
  ): Promise<void> {
    await this.logger?.log("protocol.message.received", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { type: envelope.type },
    });

    if (envelope.type !== "handoff.request") return;

    const payload = envelope.payload as HandoffRequestPayload;

    // Verify taskId matches
    if (payload.taskId !== envelope.taskId) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "taskId_mismatch" },
      });
      return;
    }

    // Load child task
    const childTask = await store.get(envelope.taskId);
    if (!childTask) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      await this.logger?.log("delegation.rejected", envelope.fromAgent, {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      return;
    }

    // Authorization check: only assigned agent can send handoff requests
    if (!(await this.checkAuthorization(envelope, childTask))) {
      return;
    }

    // Load parent task
    const parentTask = await store.get(payload.parentTaskId);
    if (!parentTask) {
      await this.logger?.log("delegation.rejected", envelope.fromAgent, {
        taskId: envelope.taskId,
        payload: { reason: "parent_not_found" },
      });
      return;
    }

    // Check delegation depth
    const parentDepth =
      typeof parentTask.frontmatter.metadata?.delegationDepth === "number"
        ? parentTask.frontmatter.metadata.delegationDepth
        : 0;

    if (parentDepth + 1 > 1) {
      await this.logger?.log("delegation.rejected", envelope.fromAgent, {
        taskId: envelope.taskId,
        payload: { reason: "nested_delegation" },
      });
      return;
    }

    // Update child metadata with delegation depth
    childTask.frontmatter.metadata = {
      ...childTask.frontmatter.metadata,
      delegationDepth: parentDepth + 1,
    };
    childTask.frontmatter.updatedAt = new Date().toISOString();

    // Write updated task
    const taskPath =
      childTask.path ??
      `${store.tasksDir}/${childTask.frontmatter.status}/${childTask.frontmatter.id}.md`;
    childTask.path = taskPath;
    await writeFileAtomic(taskPath, serializeTask(childTask));

    // Write handoff artifacts
    await writeHandoffArtifacts(store, childTask, payload);

    await this.logger?.log("delegation.requested", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: {
        parentTaskId: payload.parentTaskId,
        toAgent: payload.toAgent,
      },
    });
  }

  async handleHandoffAck(
    envelope: ProtocolEnvelopeType,
    store: ITaskStore,
  ): Promise<void> {
    await this.logger?.log("protocol.message.received", envelope.fromAgent, {
      taskId: envelope.taskId,
      payload: { type: envelope.type },
    });

    if (envelope.type !== "handoff.accepted" && envelope.type !== "handoff.rejected") return;

    const payload = envelope.payload as HandoffAckPayload;

    // Load child task
    const childTask = await store.get(envelope.taskId);
    if (!childTask) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "task_not_found" },
      });
      return;
    }

    // Authorization check: only assigned agent can send handoff acks
    if (!(await this.checkAuthorization(envelope, childTask))) {
      return;
    }

    if (envelope.type === "handoff.accepted") {
      await this.logger?.log("delegation.accepted", envelope.fromAgent, {
        taskId: envelope.taskId,
      });
    } else {
      // handoff.rejected
      const reason = payload.reason ?? "handoff_rejected";
      await this.transitionTask(childTask, "blocked", envelope.fromAgent, reason, store);
      await this.logTransition(
        childTask.frontmatter.id,
        childTask.frontmatter.status,
        "blocked",
        envelope.fromAgent,
        reason,
      );
      await this.notifyTransition(
        childTask.frontmatter.id,
        childTask.frontmatter.status,
        "blocked",
        envelope.fromAgent,
        reason,
      );
      await this.logger?.log("delegation.rejected", envelope.fromAgent, {
        taskId: envelope.taskId,
        payload: { reason },
      });
    }
  }

  private resolveAuthorizedAgent(task: Task): string | undefined {
    return task.frontmatter.lease?.agent ?? task.frontmatter.routing?.agent;
  }

  private async checkAuthorization(envelope: ProtocolEnvelopeType, task: Task): Promise<boolean> {
    const authorizedAgent = this.resolveAuthorizedAgent(task);
    if (!authorizedAgent) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "unassigned_task", sender: envelope.fromAgent }
      });
      return false;
    }
    if (envelope.fromAgent !== authorizedAgent) {
      await this.logger?.log("protocol.message.rejected", "system", {
        taskId: envelope.taskId,
        payload: { reason: "unauthorized_agent", expected: authorizedAgent, received: envelope.fromAgent }
      });
      return false;
    }
    return true;
  }

  private async applyCompletionOutcome(
    task: Task,
    opts: {
      actor: string;
      outcome: RunResult["outcome"];
      notes?: string;
      blockers?: string[];
    },
    store: ITaskStore,
  ): Promise<void> {
    const transitions = resolveCompletionTransitions(task, opts.outcome);
    if (transitions.length === 0) return;

    let current = task;
    for (const nextStatus of transitions) {
      if (current.frontmatter.status === nextStatus) continue;
      if (!isValidTransition(current.frontmatter.status, nextStatus)) continue;
      const previousStatus = current.frontmatter.status;
      current = await this.transitionTask(
        current,
        nextStatus,
        opts.actor,
        buildCompletionReason(opts),
        store,
      );
      if (current.frontmatter.status !== previousStatus) {
        await this.logTransition(
          current.frontmatter.id,
          previousStatus,
          current.frontmatter.status,
          opts.actor,
          buildCompletionReason(opts),
        );
        await this.notifyTransition(
          current.frontmatter.id,
          previousStatus,
          current.frontmatter.status,
          opts.actor,
          buildCompletionReason(opts),
        );
      }
    }
  }

  private async transitionTask(
    task: Task,
    status: TaskStatus,
    actor: string,
    reason: string | undefined,
    store: ITaskStore,
  ): Promise<Task> {
    if (task.frontmatter.status === status) return task;
    if (!isValidTransition(task.frontmatter.status, status)) return task;
    return store.transition(task.frontmatter.id, status, { reason, agent: actor });
  }

  private async appendWorkLog(
    task: Task,
    payload: StatusUpdatePayload,
    store: ITaskStore,
  ): Promise<Task> {
    const entry = buildWorkLogEntry(payload);
    if (!entry) return task;
    const body = appendSection(task.body, "Work Log", [entry]);
    return store.updateBody(task.frontmatter.id, body);
  }

  private async logTransition(taskId: string, from: TaskStatus, to: TaskStatus, actor: string, reason?: string): Promise<void> {
    await this.logger?.log("task.transitioned", actor, {
      taskId,
      payload: { from, to, reason },
    });
  }

  private async notifyTransition(taskId: string, from: TaskStatus, to: TaskStatus, actor: string, reason?: string): Promise<void> {
    if (!this.notifier) return;
    if (to !== "review" && to !== "blocked" && to !== "done") return;
    await this.notifier.notify({
      eventId: Date.now(),
      type: "task.transitioned",
      timestamp: new Date().toISOString(),
      actor,
      taskId,
      payload: { from, to, reason },
    });
  }
}

