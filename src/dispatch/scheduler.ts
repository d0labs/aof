/**
 * Deterministic Scheduler — scans tasks and dispatches work.
 *
 * Phase 0: dry-run mode only (logs what it would do, no mutations).
 * No LLM calls. Filesystem I/O only.
 */

import { FilesystemTaskStore, serializeTask } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { acquireLease, expireLeases, renewLease, releaseLease } from "../store/lease.js";
import { checkStaleHeartbeats, markRunArtifactExpired, readRunResult } from "../recovery/run-artifacts.js";
import { resolveCompletionTransitions } from "../protocol/completion-utils.js";
import { SLAChecker } from "./sla-checker.js";
import { join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import writeFileAtomic from "write-file-atomic";
import type { DispatchExecutor, TaskContext } from "./executor.js";
import type { Task, TaskStatus } from "../schemas/task.js";
import { evaluateGateTransition, type GateEvaluationInput, type GateEvaluationResult } from "./gate-evaluator.js";
import { validateWorkflow, type WorkflowConfig } from "../schemas/workflow.js";
import { ProjectManifest } from "../schemas/project.js";
import type { GateOutcome, GateTransition } from "../schemas/gate.js";
import { parseDuration } from "./duration-parser.js";
import { buildGateContext } from "./gate-context-builder.js";

export interface SchedulerConfig {
  /** Root data directory. */
  dataDir: string;
  /** Dry-run mode: log decisions but don't mutate state. */
  dryRun: boolean;
  /** Default lease TTL in ms. */
  defaultLeaseTtlMs: number;
  /** Heartbeat TTL in ms (default 5min). */
  heartbeatTtlMs?: number;
  /** Executor for spawning agent sessions (optional — if absent, assign actions are logged only). */
  executor?: DispatchExecutor;
  /** Spawn timeout in ms (default 30s). */
  spawnTimeoutMs?: number;
  /** SLA checker instance (optional — created if not provided). */
  slaChecker?: SLAChecker;
  /** Maximum concurrent in-progress tasks across all agents (default: 3). */
  maxConcurrentDispatches?: number;
}

export interface SchedulerAction {
  type: "expire_lease" | "assign" | "requeue" | "block" | "deadletter" | "alert" | "stale_heartbeat" | "sla_violation" | "promote";
  taskId: string;
  taskTitle: string;
  agent?: string;
  reason: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;  // For promote actions
  duration?: number;  // For SLA violations: actual duration
  limit?: number;     // For SLA violations: SLA limit
}

export interface PollResult {
  scannedAt: string;
  durationMs: number;
  dryRun: boolean;
  actions: SchedulerAction[];
  stats: {
    total: number;
    backlog: number;
    ready: number;
    inProgress: number;
    blocked: number;
    review: number;
    done: number;
  };
}

function isLeaseActive(lease?: Task["frontmatter"]["lease"]): boolean {
  if (!lease) return false;
  const expiresAt = new Date(lease.expiresAt).getTime();
  return expiresAt > Date.now();
}

const LEASE_RENEWAL_MAX = 20;
const leaseRenewalTimers = new Map<string, NodeJS.Timeout>();

/**
 * Effective concurrency limit — auto-detected from OpenClaw platform limit.
 * Starts null, set to min(platformLimit, config.maxConcurrentDispatches) when detected.
 */
let effectiveConcurrencyLimit: number | null = null;

function leaseRenewalKey(store: ITaskStore, taskId: string): string {
  return `${store.projectId}:${taskId}`;
}

function stopLeaseRenewal(store: ITaskStore, taskId: string): void {
  const key = leaseRenewalKey(store, taskId);
  const timer = leaseRenewalTimers.get(key);
  if (!timer) return;
  clearInterval(timer);
  leaseRenewalTimers.delete(key);
}

function startLeaseRenewal(store: ITaskStore, taskId: string, agentId: string, leaseTtlMs: number): void {
  const key = leaseRenewalKey(store, taskId);
  if (leaseRenewalTimers.has(key)) return;

  const intervalMs = Math.max(1, Math.floor(leaseTtlMs / 2));
  const timer = setInterval(() => {
    void renewLease(store, taskId, agentId, {
      ttlMs: leaseTtlMs,
      maxRenewals: LEASE_RENEWAL_MAX,
    }).catch(() => {
      stopLeaseRenewal(store, taskId);
    });
  }, intervalMs);

  timer.unref?.();
  leaseRenewalTimers.set(key, timer);
}

function cleanupLeaseRenewals(store: ITaskStore, tasks: Task[]): void {
  const active = new Set<string>();
  for (const task of tasks) {
    if (task.frontmatter.status !== "in-progress") continue;
    const lease = task.frontmatter.lease;
    if (!lease || !lease.agent) continue;
    if (!isLeaseActive(lease)) continue;
    active.add(leaseRenewalKey(store, task.frontmatter.id));
  }

  const prefix = `${store.projectId}:`;
  for (const key of leaseRenewalTimers.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (active.has(key)) continue;
    const taskId = key.slice(prefix.length);
    stopLeaseRenewal(store, taskId);
  }
}

/**
 * Check if a backlog task is eligible for promotion to ready.
 * 
 * @param task - Task to check
 * @param allTasks - All tasks (for dependency lookup)
 * @param childrenByParent - Map of parent→children tasks
 * @returns Eligibility result with reason if blocked
 */
export function checkPromotionEligibility(
  task: Task,
  allTasks: Task[],
  childrenByParent: Map<string, Task[]>
): { eligible: boolean; reason?: string } {
  
  // 1. Check dependencies
  const deps = task.frontmatter.dependsOn ?? [];
  if (deps.length > 0) {
    for (const depId of deps) {
      const dep = allTasks.find(t => t.frontmatter.id === depId);
      if (!dep) {
        return { eligible: false, reason: `Missing dependency: ${depId}` };
      }
      if (dep.frontmatter.status !== "done") {
        return { eligible: false, reason: `Waiting on dependency: ${depId}` };
      }
    }
  }

  // 2. Check subtasks (parentId references)
  const subtasks = childrenByParent.get(task.frontmatter.id) ?? [];
  const incompleteSubtasks = subtasks.filter(st => st.frontmatter.status !== "done");
  if (incompleteSubtasks.length > 0) {
    return { 
      eligible: false, 
      reason: `Waiting on ${incompleteSubtasks.length} subtask(s)` 
    };
  }

  // 3. Check routing target
  const routing = task.frontmatter.routing;
  const hasTarget = routing.agent || routing.role || routing.team;
  if (!hasTarget) {
    return { 
      eligible: false, 
      reason: "No routing target (needs agent/role/team)" 
    };
  }

  // 4. Check active lease (shouldn't happen in backlog, but safety check)
  if (isLeaseActive(task.frontmatter.lease)) {
    return { 
      eligible: false, 
      reason: "Active lease (corrupted state?)" 
    };
  }

  // 5. Future: Check approval gate (Phase 2)
  // const requiresApproval = task.frontmatter.metadata?.requiresApproval;
  // if (requiresApproval) {
  //   return { eligible: false, reason: "Requires manual approval" };
  // }

  return { eligible: true };
}

/**
 * Load project manifest from project.yaml file.
 * 
 * @param store - Task store
 * @param projectId - Project identifier
 * @returns Project manifest or null if not found
 */
async function loadProjectManifest(
  store: ITaskStore,
  projectId: string
): Promise<ProjectManifest | null> {
  try {
    const projectPath = join(store.projectRoot, "projects", projectId, "project.yaml");
    const content = await readFile(projectPath, "utf-8");
    const manifest = parseYaml(content) as ProjectManifest;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Check for tasks exceeding gate timeouts and escalate.
 * 
 * @param store - Task store
 * @param logger - Event logger
 * @param config - Scheduler config
 * @param metrics - Optional metrics instance
 * @returns Array of scheduler actions (alerts for timeouts)
 */
async function checkGateTimeouts(
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: import("../metrics/exporter.js").AOFMetrics
): Promise<SchedulerAction[]> {
  const actions: SchedulerAction[] = [];
  const now = Date.now();
  
  // Scan all in-progress tasks
  const tasks = await store.list({ status: "in-progress" });
  
  for (const task of tasks) {
    // Skip tasks not in gate workflow
    if (!task.frontmatter.gate) continue;
    
    // Load project workflow
    const projectId = task.frontmatter.project;
    if (!projectId) continue;
    
    const projectManifest = await loadProjectManifest(store, projectId);
    if (!projectManifest?.workflow) continue;
    
    const workflow = projectManifest.workflow;
    const currentGate = workflow.gates.find(g => g.id === task.frontmatter.gate?.current);
    if (!currentGate) continue;
    
    // Check if gate has timeout configured
    if (!currentGate.timeout) continue;
    
    // Parse timeout duration
    const timeoutMs = parseDuration(currentGate.timeout);
    if (!timeoutMs) {
      console.warn(
        `[AOF] Invalid timeout format for gate ${currentGate.id}: ${currentGate.timeout}`
      );
      continue;
    }
    
    // Check if task has exceeded timeout
    const entered = new Date(task.frontmatter.gate.entered).getTime();
    const elapsed = now - entered;
    
    if (elapsed > timeoutMs) {
      // Timeout exceeded - escalate
      const action = await escalateGateTimeout(
        task,
        currentGate,
        workflow,
        elapsed,
        store,
        logger,
        config,
        metrics
      );
      actions.push(action);
    }
  }
  
  return actions;
}

/**
 * Escalate a task that has exceeded gate timeout.
 * 
 * @param task - Task that exceeded timeout
 * @param gate - Gate with timeout
 * @param workflow - Workflow config
 * @param elapsedMs - Time elapsed in gate (milliseconds)
 * @param store - Task store
 * @param logger - Event logger
 * @param config - Scheduler config
 * @returns Scheduler action (alert)
 */
async function escalateGateTimeout(
  task: Task,
  gate: { id: string; role: string; timeout?: string; escalateTo?: string },
  workflow: WorkflowConfig,
  elapsedMs: number,
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: import("../metrics/exporter.js").AOFMetrics
): Promise<SchedulerAction> {
  const escalateToRole = gate.escalateTo;
  
  if (!escalateToRole) {
    // No escalation target - just log and emit metric
    console.warn(
      `[AOF] Gate timeout: task ${task.frontmatter.id} exceeded ${gate.timeout} at gate ${gate.id}, no escalation configured`
    );
    
    try {
      await logger.log("gate_timeout", "scheduler", {
        taskId: task.frontmatter.id,
        payload: {
          gate: gate.id,
          elapsed: elapsedMs,
          timeout: gate.timeout,
        },
      });
      
      // Record timeout metric
      if (metrics) {
        const project = task.frontmatter.project ?? store.projectId;
        metrics.recordGateTimeout(project, workflow.name, gate.id);
      }
    } catch {
      // Logging errors should not crash the scheduler
    }
    
    return {
      type: "alert",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      reason: `Gate ${gate.id} timeout (${Math.floor(elapsedMs / 1000)}s), no escalation configured`,
    };
  }
  
  // Don't mutate in dry-run mode
  if (!config.dryRun) {
    // Update task routing to escalation role
    task.frontmatter.routing.role = escalateToRole;
    task.frontmatter.updatedAt = new Date().toISOString();
    
    // Add note to gate history
    const historyEntry = {
      gate: gate.id,
      role: gate.role,
      entered: task.frontmatter.gate!.entered,
      exited: new Date().toISOString(),
      outcome: "blocked" as const,
      summary: `Timeout exceeded (${Math.floor(elapsedMs / 1000)}s), escalated to ${escalateToRole}`,
      blockers: [`Timeout: no response from ${gate.role} within ${gate.timeout}`],
      duration: Math.floor(elapsedMs / 1000),
    };
    
    task.frontmatter.gateHistory = [
      ...(task.frontmatter.gateHistory ?? []),
      historyEntry,
    ];
    
    // Update task
    const serialized = serializeTask(task);
    const taskPath = task.path ?? join(store.tasksDir, task.frontmatter.status, `${task.frontmatter.id}.md`);
    await writeFileAtomic(taskPath, serialized);
    
    // Log event
    try {
      await logger.log("gate_timeout_escalation", "scheduler", {
        taskId: task.frontmatter.id,
        payload: {
          gate: gate.id,
          fromRole: gate.role,
          toRole: escalateToRole,
          elapsed: elapsedMs,
          timeout: gate.timeout,
        },
      });
      
      // Record timeout and escalation metrics
      if (metrics) {
        const project = task.frontmatter.project ?? store.projectId;
        metrics.recordGateTimeout(project, workflow.name, gate.id);
        metrics.recordGateEscalation(project, workflow.name, gate.id, escalateToRole);
      }
    } catch {
      // Logging errors should not crash the scheduler
    }
  }
  
  return {
    type: "alert",
    taskId: task.frontmatter.id,
    taskTitle: task.frontmatter.title,
    agent: escalateToRole,
    reason: `Gate ${gate.id} timeout, escalated from ${gate.role} to ${escalateToRole}`,
  };
}

/**
 * Run one scheduler poll cycle.
 *
 * In dry-run mode, returns planned actions without executing them.
 * In active mode, executes the actions (Phase 1+).
 */
export async function poll(
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  metrics?: import("../metrics/exporter.js").AOFMetrics,
): Promise<PollResult> {
  const start = performance.now();
  const actions: SchedulerAction[] = [];

  // 1. List all tasks
  const allTasks = await store.list();
  cleanupLeaseRenewals(store, allTasks);

  const childrenByParent = new Map<string, Task[]>();
  for (const task of allTasks) {
    const parentId = task.frontmatter.parentId;
    if (!parentId) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(task);
    childrenByParent.set(parentId, list);
  }

  // 2. Build stats
  const stats = {
    total: allTasks.length,
    backlog: 0,
    ready: 0,
    inProgress: 0,
    blocked: 0,
    review: 0,
    done: 0,
  };

  for (const task of allTasks) {
    const s = task.frontmatter.status;
    if (s === "backlog") stats.backlog++;
    else if (s === "ready") stats.ready++;
    else if (s === "in-progress") stats.inProgress++;
    else if (s === "blocked") stats.blocked++;
    else if (s === "review") stats.review++;
    else if (s === "done") stats.done++;
  }

  // 3. Check for expired leases (BUG-AUDIT-001: check both in-progress AND blocked)
  const inProgressTasks = allTasks.filter(t => t.frontmatter.status === "in-progress");
  const blockedTasks = allTasks.filter(t => t.frontmatter.status === "blocked");
  const tasksWithPotentialLeases = [...inProgressTasks, ...blockedTasks];

  for (const task of tasksWithPotentialLeases) {
    const lease = task.frontmatter.lease;
    if (!lease) continue;

    const expiresAt = new Date(lease.expiresAt).getTime();
    if (expiresAt <= Date.now()) {
      const expiredDuration = Date.now() - expiresAt;
      actions.push({
        type: "expire_lease",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        agent: lease.agent,
        reason: `Lease expired at ${lease.expiresAt} (held by ${lease.agent}, expired ${Math.round(expiredDuration / 1000)}s ago)`,
        fromStatus: task.frontmatter.status,
      });
    }
  }

  // 3.5. Build resource occupancy map (TASK-054: resource serialization)
  // Track which resources are currently occupied by in-progress tasks
  const occupiedResources = new Map<string, string>(); // resource -> taskId
  for (const task of inProgressTasks) {
    const resource = task.frontmatter.resource;
    if (resource) {
      occupiedResources.set(resource, task.frontmatter.id);
    }
  }

  // 3.6. Check for stale heartbeats (P2.3 resume protocol)
  const heartbeatTtl = config.heartbeatTtlMs ?? 300_000; // 5min default
  const staleHeartbeats = await checkStaleHeartbeats(store, heartbeatTtl);
  
  for (const heartbeat of staleHeartbeats) {
    const task = allTasks.find(t => t.frontmatter.id === heartbeat.taskId);
    if (!task) continue;

    actions.push({
      type: "stale_heartbeat",
      taskId: heartbeat.taskId,
      taskTitle: task.frontmatter.title,
      agent: heartbeat.agentId,
      reason: `Heartbeat expired at ${heartbeat.expiresAt} (no update from ${heartbeat.agentId})`,
    });
  }

  const blockedBySubtasks = new Set<string>();
  for (const [parentId, children] of childrenByParent) {
    const hasIncomplete = children.some(child => child.frontmatter.status !== "done");
    if (hasIncomplete) blockedBySubtasks.add(parentId);
  }

  // 3.7. TASK-055: Build dependency graph and check for circular dependencies
  const circularDeps = new Set<string>();
  
  function detectCircularDeps(taskId: string, visited: Set<string>, stack: Set<string>): boolean {
    if (stack.has(taskId)) {
      // Found a cycle
      const cycleStart = Array.from(stack).indexOf(taskId);
      const cycle = Array.from(stack).slice(cycleStart).concat(taskId);
      console.error(`[AOF] Circular dependency detected: ${cycle.join(" → ")}`);
      return true;
    }
    
    if (visited.has(taskId)) {
      return false; // Already checked this branch
    }
    
    visited.add(taskId);
    stack.add(taskId);
    
    const task = allTasks.find(t => t.frontmatter.id === taskId);
    if (task) {
      for (const depId of task.frontmatter.dependsOn) {
        if (detectCircularDeps(depId, visited, stack)) {
          return true;
        }
      }
    }
    
    stack.delete(taskId);
    return false;
  }
  
  // Check all tasks for circular dependencies
  for (const task of allTasks) {
    if (task.frontmatter.dependsOn.length > 0) {
      const visited = new Set<string>();
      const stack = new Set<string>();
      if (detectCircularDeps(task.frontmatter.id, visited, stack)) {
        circularDeps.add(task.frontmatter.id);
      }
    }
  }

  // 3.8. Check for SLA violations (AOF-ae6: SLA scheduler integration)
  const slaChecker = config.slaChecker ?? new SLAChecker();
  const projectManifest = {}; // TODO: Load from project.yaml when available
  const slaViolations = slaChecker.checkViolations(allTasks, projectManifest);
  
  for (const violation of slaViolations) {
    const shouldAlert = slaChecker.shouldAlert(violation.taskId);
    const durationHrs = (violation.duration / 3600000).toFixed(1);
    const limitHrs = (violation.limit / 3600000).toFixed(1);
    
    actions.push({
      type: "sla_violation",
      taskId: violation.taskId,
      taskTitle: violation.title,
      agent: violation.agent,
      reason: shouldAlert
        ? `SLA violation: ${durationHrs}h in-progress (limit: ${limitHrs}h) — alert will be sent`
        : `SLA violation: ${durationHrs}h in-progress (limit: ${limitHrs}h) — alert rate-limited`,
      duration: violation.duration,
      limit: violation.limit,
    });
  }

  // 3.9. Check for gate timeouts (AOF-69l: gate timeout detection)
  const timeoutActions = await checkGateTimeouts(store, logger, config, metrics);
  actions.push(...timeoutActions);

  // 3.1. Check for backlog tasks that can be promoted
  const backlogTasks = allTasks.filter(t => t.frontmatter.status === "backlog");
  
  for (const task of backlogTasks) {
    // Check promotion eligibility
    const canPromote = checkPromotionEligibility(task, allTasks, childrenByParent);
    
    if (canPromote.eligible) {
      actions.push({
        type: "promote",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: "Auto-promotion: all requirements met",
        fromStatus: "backlog",
        toStatus: "ready",
      });
    }
  }

  // 4. Check for ready tasks that can be assigned
  const readyTasks = allTasks.filter(t => t.frontmatter.status === "ready");
  const maxDispatches = effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3;
  const currentInProgress = stats.inProgress;
  let pendingDispatches = 0;
  
  // Log concurrency status
  console.info(
    `[AOF] Concurrency limit: ${currentInProgress}/${maxDispatches} in-progress` +
    (effectiveConcurrencyLimit !== null ? ` (platform-adjusted from ${config.maxConcurrentDispatches ?? 3})` : "")
  );
  
  for (const task of readyTasks) {
    if (blockedBySubtasks.has(task.frontmatter.id)) continue;
    
    // TASK-055: Check for circular dependencies - block if detected
    if (circularDeps.has(task.frontmatter.id)) {
      actions.push({
        type: "block",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: "Circular dependency detected",
        fromStatus: task.frontmatter.status,
      });
      continue;
    }
    
    // TASK-055: Dependency gating - check if all dependencies are done
    const deps = task.frontmatter.dependsOn;
    if (deps.length > 0) {
      const unresolvedDeps: string[] = [];
      
      for (const depId of deps) {
        const dep = allTasks.find(t => t.frontmatter.id === depId);
        if (!dep) {
          unresolvedDeps.push(depId);
        } else if (dep.frontmatter.status !== "done") {
          unresolvedDeps.push(depId);
        }
      }
      
      if (unresolvedDeps.length > 0) {
        console.warn(`[AOF] Dependency gate: skipping ${task.frontmatter.id} (waiting on: ${unresolvedDeps.join(", ")})`);
        continue;
      }
    }
    
    if (isLeaseActive(task.frontmatter.lease)) {
      const lease = task.frontmatter.lease;
      console.warn(
        `[AOF] Dispatch dedup: skipping ${task.frontmatter.id} (active lease held by ${lease?.agent} until ${lease?.expiresAt})`,
      );
      continue;
    }

    // TASK-054: Resource serialization - skip if resource is occupied
    const resource = task.frontmatter.resource;
    if (resource && occupiedResources.has(resource)) {
      const occupyingTaskId = occupiedResources.get(resource)!;
      console.warn(`[AOF] Resource lock: skipping ${task.frontmatter.id} (resource "${resource}" occupied by ${occupyingTaskId})`);
      continue;
    }
    
    // Concurrency cap: skip if at capacity
    if (currentInProgress + pendingDispatches >= maxDispatches) {
      console.info(`[AOF] Concurrency cap: skipping ${task.frontmatter.id} (${currentInProgress} in-progress + ${pendingDispatches} pending >= ${maxDispatches})`);
      continue;
    }
    
    const routing = task.frontmatter.routing;
    const targetAgent = routing.agent ?? routing.role ?? routing.team;

    if (targetAgent) {
      actions.push({
        type: "assign",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        agent: targetAgent,
        reason: `Pending task with routing target: ${targetAgent}`,
      });
      pendingDispatches++;
    } else if (routing.tags && routing.tags.length > 0) {
      // GAP-004 fix: Task has tags but no explicit agent/role/team
      // Log error and create alert action (tags-only routing not supported)
      console.error(`[AOF] [GAP-004] Task ${task.frontmatter.id} has tags-only routing (not supported)`);
      console.error(`[AOF] [GAP-004]   Tags: ${routing.tags.join(", ")}`);
      console.error(`[AOF] [GAP-004]   Task needs explicit assignee via routing.agent, routing.role, or routing.team`);
      console.error(`[AOF] [GAP-004]   Use: aof_dispatch --agent <agent-id> to assign explicitly`);

      actions.push({
        type: "alert",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: `Task has tags (${routing.tags.join(", ")}) but no routing target — needs explicit agent/role/team assignment`,
      });
    } else {
      actions.push({
        type: "alert",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: "Pending task with no routing target — needs manual assignment",
      });
    }
  }

  // 4.5 Block parents with incomplete subtasks
  for (const task of allTasks) {
    if (!blockedBySubtasks.has(task.frontmatter.id)) continue;
    if (task.frontmatter.status === "blocked" || task.frontmatter.status === "done") continue;

    actions.push({
      type: "block",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      reason: "Parent task has incomplete subtasks",
      fromStatus: task.frontmatter.status,
    });
  }

  // 5. Check for blocked tasks that might be unblocked
  const blockedTasksForRecovery = allTasks.filter(t => t.frontmatter.status === "blocked");
  for (const task of blockedTasksForRecovery) {
    const deps = task.frontmatter.dependsOn;
    const childTasks = childrenByParent.get(task.frontmatter.id) ?? [];
    const hasGate = deps.length > 0 || childTasks.length > 0;

    // BUG-002: Check for dispatch failure recovery (tasks blocked due to spawn failures)
    const retryCount = (task.frontmatter.metadata?.retryCount as number) ?? 0;
    const lastBlockedAt = task.frontmatter.metadata?.lastBlockedAt as string | undefined;
    const blockReason = task.frontmatter.metadata?.blockReason as string | undefined;
    const maxRetries = 3; // Maximum retry attempts
    const retryDelayMs = 5 * 60 * 1000; // 5 minutes between retries

    // Check if this is a dispatch-failure block (not dependency-based)
    const isDispatchFailure = blockReason?.includes("spawn_failed") ?? false;

    if (isDispatchFailure && retryCount < maxRetries) {
      // Check if enough time has passed for retry
      if (lastBlockedAt) {
        const blockedAge = Date.now() - new Date(lastBlockedAt).getTime();
        if (blockedAge >= retryDelayMs) {
          actions.push({
            type: "requeue",
            taskId: task.frontmatter.id,
            taskTitle: task.frontmatter.title,
            reason: `Retry attempt ${retryCount + 1}/${maxRetries} after dispatch failure`,
          });
          continue; // Skip dependency check for dispatch-failure tasks
        }
      }
    } else if (isDispatchFailure && retryCount >= maxRetries) {
      // Max retries exceeded - emit alert
      actions.push({
        type: "alert",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: `Max retries (${maxRetries}) exceeded for dispatch failures — manual intervention required`,
      });
      continue; // Skip dependency check
    }

    // Dependency-based unblocking (existing logic)
    if (!hasGate) continue;

    const allDepsResolved = deps.every(depId => {
      const dep = allTasks.find(t => t.frontmatter.id === depId);
      return dep?.frontmatter.status === "done";
    });
    const allSubtasksResolved = childTasks.every(child => child.frontmatter.status === "done");

    if (allDepsResolved && allSubtasksResolved) {
      actions.push({
        type: "requeue",
        taskId: task.frontmatter.id,
        taskTitle: task.frontmatter.title,
        reason: "All dependencies resolved — can be requeued",
      });
    }
  }

  // 6. Execute actions (only in active mode)
  let actionsExecuted = 0;
  let actionsFailed = 0;
  let leasesExpired = 0;  // BUG-AUDIT-004: Track lease expiry count
  let tasksRequeued = 0;  // BUG-AUDIT-004: Track requeue count
  let tasksPromoted = 0;  // TASK-2026-02-14: Track promotion count
  
  if (!config.dryRun) {
    for (const action of actions) {
      try {
        let executed = false;
        let failed = false;
        switch (action.type) {
          case "expire_lease":
            // BUG-AUDIT-001/002: Handle lease expiry for both in-progress and blocked tasks
            const expiringTask = await store.get(action.taskId);
            if (expiringTask) {
              // Clear the lease first
              expiringTask.frontmatter.lease = undefined;
              const serialized = serializeTask(expiringTask);
              const taskPath = expiringTask.path ?? join(store.tasksDir, expiringTask.frontmatter.status, `${expiringTask.frontmatter.id}.md`);
              await writeFileAtomic(taskPath, serialized);
              
              // BUG-AUDIT-002: For blocked tasks, check dependencies before requeueing
              if (expiringTask.frontmatter.status === "blocked") {
                const deps = expiringTask.frontmatter.dependsOn ?? [];
                const allDepsResolved = deps.length === 0 || deps.every(depId => {
                  const dep = allTasks.find(t => t.frontmatter.id === depId);
                  return dep?.frontmatter.status === "done";
                });
                
                if (allDepsResolved) {
                  // Dependencies satisfied - can requeue to ready
                  await store.transition(action.taskId, "ready", { 
                    reason: "lease_expired_requeue" 
                  });
                  
                  try {
                    await logger.logTransition(action.taskId, "blocked", "ready", "scheduler", 
                      `Lease expired and dependencies satisfied - requeued`);
                  } catch {
                    // Logging errors should not crash the scheduler
                  }
                } else {
                  // Dependencies not satisfied - just log lease expiry, stay blocked
                  console.warn(`[AOF] Lease expired on blocked task ${action.taskId} but dependencies not satisfied - staying blocked`);
                }
              } else {
                // In-progress task - transition back to ready
                await store.transition(action.taskId, "ready", { reason: "lease_expired" });
              }
              
              // BUG-AUDIT-003: Mark run artifacts as expired
              try {
                await markRunArtifactExpired(store, action.taskId, action.reason ?? "Lease expired");
              } catch {
                // Non-critical failure if no run artifacts exist
              }
              
              // BUG-AUDIT-004: Emit lease.expired event with telemetry
              try {
                await logger.logLease("lease.expired", action.taskId, action.agent ?? "unknown");
              } catch {
                // Logging errors should not crash the scheduler
              }
              
              // BUG-AUDIT-004: Increment telemetry counters
              leasesExpired++;
              if (expiringTask.frontmatter.status === "ready") {
                tasksRequeued++;  // Successfully requeued to ready
              }
            }
            // BUG-002 fix: Don't count non-dispatch actions in actionsExecuted
            // executed remains false
            break;
          case "stale_heartbeat":
            // TASK-2026-02-10-061: Consult run_result.json for deterministic recovery
            const staleTask = await store.get(action.taskId);
            if (!staleTask) {
              console.warn(`[AOF] Stale heartbeat: task ${action.taskId} not found, skipping`);
              break;
            }

            const runResult = await readRunResult(store, action.taskId);
            const fromStatus = staleTask.frontmatter.status;

            if (!runResult) {
              // No run result → reclaim to ready, mark artifact expired
              await store.transition(action.taskId, "ready", { reason: "stale_heartbeat_reclaim" });
              await markRunArtifactExpired(store, action.taskId, "stale_heartbeat");
              
              try {
                await logger.logTransition(action.taskId, fromStatus, "ready", "scheduler", 
                  `Stale heartbeat - no run_result - reclaimed to ready`);
              } catch {
                // Logging errors should not crash the scheduler
              }
            } else {
              // Run result exists → apply outcome-driven transitions
              const transitions = resolveCompletionTransitions(staleTask, runResult.outcome);
              
              for (const targetStatus of transitions) {
                await store.transition(action.taskId, targetStatus, { 
                  reason: `stale_heartbeat_${runResult.outcome}` 
                });
                
                try {
                  await logger.logTransition(action.taskId, fromStatus, targetStatus, "scheduler",
                    `Stale heartbeat - outcome ${runResult.outcome} - transition to ${targetStatus}`);
                } catch {
                  // Logging errors should not crash the scheduler
                }
              }
            }
            // BUG-002 fix: Don't count non-dispatch actions in actionsExecuted
            // executed remains false
            break;
          case "requeue":
            // BUG-002: Update metadata before transition
            const requeuedTask = await store.get(action.taskId);
            if (requeuedTask) {
              requeuedTask.frontmatter.metadata = {
                ...requeuedTask.frontmatter.metadata,
                lastRequeuedAt: new Date().toISOString(),
                requeueReason: action.reason,
                // Keep retry count to track cumulative attempts
              };
              
              // Write updated task with metadata before transition
              const serialized = serializeTask(requeuedTask);
              const taskPath = requeuedTask.path ?? join(store.tasksDir, requeuedTask.frontmatter.status, `${requeuedTask.frontmatter.id}.md`);
              await writeFileAtomic(taskPath, serialized);
            }
            
            await store.transition(action.taskId, "ready", { reason: action.reason });
            
            try {
              await logger.logTransition(action.taskId, "blocked", "ready", "scheduler", action.reason);
            } catch {
              // Logging errors should not crash the scheduler
            }
            // BUG-002 fix: Don't count non-dispatch actions in actionsExecuted
            // executed remains false
            break;
          case "block":
            await store.transition(action.taskId, "blocked", { reason: action.reason });
            try {
              await logger.logTransition(
                action.taskId,
                action.fromStatus ?? "unknown",
                "blocked",
                "scheduler",
                action.reason,
              );
            } catch {
              // Logging errors should not crash the scheduler
            }
            // BUG-002 fix: Don't count non-dispatch actions in actionsExecuted
            // executed remains false
            break;
          case "assign":
            // BUG-003: Log when executor is missing (but don't count as failed - nothing was attempted)
            if (!config.executor) {
              console.error(`[AOF] [BUG-003] Cannot dispatch task ${action.taskId}: executor is undefined`);
              console.error(`[AOF] [BUG-003]   Agent: ${action.agent}`);
              console.error(`[AOF] [BUG-003]   Task will remain in ready/ until executor is configured`);
              // Don't set failed=true - no execution was attempted
              break;
            }

            if (config.executor) {
              try {
                const latest = await store.get(action.taskId);
                if (!latest) {
                  console.warn(`[AOF] [TASK-056] Task ${action.taskId} not found, skipping dispatch`);
                  continue;
                }

                if (latest.frontmatter.status !== "ready") {
                  console.warn(
                    `[AOF] [TASK-056] Dispatch dedup: skipping ${action.taskId} (status ${latest.frontmatter.status})`,
                  );
                  continue;
                }

                if (isLeaseActive(latest.frontmatter.lease)) {
                  const lease = latest.frontmatter.lease;
                  console.warn(
                    `[AOF] [TASK-056] Dispatch dedup: skipping ${action.taskId} (active lease held by ${lease?.agent} until ${lease?.expiresAt})`,
                  );
                  continue;
                }

                const task = allTasks.find(t => t.frontmatter.id === action.taskId);
                if (!task) {
                  console.warn(`[AOF] [BUG-001] Task ${action.taskId} not found in allTasks, skipping dispatch`);
                  continue;
                }

                // BUG-001 diagnostic: Log before dispatch attempt
                console.info(`[AOF] [BUG-001] Attempting dispatch for task ${action.taskId} with agent ${action.agent}`);

                // Log action start (non-fatal if logging fails)
                try {
                  await logger.logAction("action.started", "scheduler", action.taskId, {
                    action: action.type,
                    agent: action.agent,
                  });
                } catch (logErr) {
                  // BUG-003: Log the logging error itself
                  console.error(`[AOF] [BUG-003] Failed to log action.started: ${(logErr as Error).message}`);
                }

                // Acquire lease first (this also transitions ready → in-progress)
                console.info(`[AOF] [BUG-001] Acquiring lease for task ${action.taskId}`);
                const leasedTask = await acquireLease(store, action.taskId, action.agent!, {
                  ttlMs: config.defaultLeaseTtlMs,
                });
                console.info(`[AOF] [BUG-001] Lease acquired for task ${action.taskId}`);

                // Build task context using post-lease task path (now in-progress/)
                const taskPath =
                  leasedTask?.path ?? join(store.tasksDir, "in-progress", `${action.taskId}.md`);
                const context: TaskContext = {
                  taskId: action.taskId,
                  taskPath,
                  agent: action.agent!,
                  priority: leasedTask?.frontmatter.priority ?? task.frontmatter.priority,
                  routing: leasedTask?.frontmatter.routing ?? task.frontmatter.routing,
                  projectId: store.projectId,
                  projectRoot: store.projectRoot,
                  taskRelpath: relative(store.projectRoot, taskPath),
                };

                // AOF-ofi: Inject gate context for workflow tasks (Progressive Disclosure L2)
                const taskForContext = leasedTask ?? task;
                if (taskForContext.frontmatter.gate) {
                  const projectId = taskForContext.frontmatter.project;
                  const projectManifest = await loadProjectManifest(store, projectId);
                  
                  if (projectManifest?.workflow) {
                    const currentGate = projectManifest.workflow.gates.find(
                      (g) => g.id === taskForContext.frontmatter.gate?.current
                    );
                    
                    if (currentGate) {
                      context.gateContext = buildGateContext(
                        taskForContext,
                        currentGate,
                        projectManifest.workflow
                      );
                    }
                  }
                }

                // BUG-001 diagnostic: Log immediately before executor invocation
                console.info(`[AOF] [BUG-001] Invoking executor.spawn() for task ${action.taskId}, agent ${action.agent}`);
                console.info(`[AOF] [BUG-001] Context: ${JSON.stringify(context)}`);

                // Spawn agent session
                const result = await config.executor.spawn(context, {
                  timeoutMs: config.spawnTimeoutMs ?? 30_000,
                });

                // BUG-001 diagnostic: Log executor result
                console.info(`[AOF] [BUG-001] Executor returned: ${JSON.stringify(result)}`);

                if (result.success) {
                  try {
                    await logger.logDispatch("dispatch.matched", "scheduler", action.taskId, {
                      agent: action.agent,
                      sessionId: result.sessionId,
                    });
                  } catch {
                    // Logging errors should not crash the scheduler
                  }
                  
                  // Log action completion
                  try {
                    await logger.logAction("action.completed", "scheduler", action.taskId, {
                      action: action.type,
                      success: true,
                      sessionId: result.sessionId,
                    });
                  } catch {
                    // Logging errors should not crash the scheduler
                  }

                  startLeaseRenewal(store, action.taskId, action.agent!, config.defaultLeaseTtlMs);
                  executed = true;
                } else {
                  // Check if this is a platform concurrency limit error
                  if (result.platformLimit !== undefined) {
                    const previousCap = effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3;
                    effectiveConcurrencyLimit = Math.min(result.platformLimit, config.maxConcurrentDispatches ?? 3);
                    
                    console.info(
                      `[AOF] Platform concurrency limit detected: ${result.platformLimit}, ` +
                      `effective cap now ${effectiveConcurrencyLimit} (was ${previousCap})`
                    );
                    
                    // Emit event (non-fatal if logging fails)
                    try {
                      await logger.log("concurrency.platformLimit", "scheduler", {
                        taskId: action.taskId,
                        payload: {
                          detectedLimit: result.platformLimit,
                          effectiveCap: effectiveConcurrencyLimit,
                          previousCap,
                        },
                      });
                    } catch (logErr) {
                      console.error(`[AOF] Failed to log concurrency.platformLimit event: ${(logErr as Error).message}`);
                    }
                    
                    // Release lease — task transitions back to ready (not blocked)
                    try {
                      await releaseLease(store, action.taskId, action.agent!);
                    } catch (releaseErr) {
                      console.error(`[AOF] Failed to release lease for ${action.taskId}: ${(releaseErr as Error).message}`);
                    }
                    
                    // No retry count increment - this is capacity exhaustion, not failure
                    console.info(
                      `[AOF] Task ${action.taskId} requeued to ready (platform capacity exhausted, ` +
                      `will retry next poll)`
                    );
                    
                    continue; // Skip normal block transition and move to next action
                  }
                  
                  // BUG-003: Log spawn failure with full context
                  console.error(`[AOF] [BUG-003] Executor spawn failed for task ${action.taskId}:`);
                  console.error(`[AOF] [BUG-003]   Agent: ${action.agent}`);
                  console.error(`[AOF] [BUG-003]   Error: ${result.error}`);
                  console.error(`[AOF] [BUG-003]   Task will be moved to blocked/`);

                  // BUG-002: Track retry count and timestamp in metadata
                  const currentTask = await store.get(action.taskId);
                  const retryCount = ((currentTask?.frontmatter.metadata?.retryCount as number) ?? 0) + 1;
                  
                  // Update metadata before transition (BUG-002)
                  if (currentTask) {
                    currentTask.frontmatter.metadata = {
                      ...currentTask.frontmatter.metadata,
                      retryCount,
                      lastBlockedAt: new Date().toISOString(),
                      blockReason: `spawn_failed: ${result.error}`,
                      lastError: result.error,
                    };
                    
                    // Write updated task with metadata before transition
                    const serialized = serializeTask(currentTask);
                    const taskPath = currentTask.path ?? join(store.tasksDir, currentTask.frontmatter.status, `${currentTask.frontmatter.id}.md`);
                    await writeFileAtomic(taskPath, serialized);
                  }
                  
                  // Spawn failed — move to blocked
                  await store.transition(action.taskId, "blocked", {
                    reason: `spawn_failed: ${result.error}`,
                  });
                  
                  try {
                    await logger.logDispatch("dispatch.error", "scheduler", action.taskId, {
                      agent: action.agent,
                      error: result.error,
                      errorMessage: result.error,
                    });
                  } catch (logErr) {
                    console.error(`[AOF] [BUG-003] Failed to log dispatch.error: ${(logErr as Error).message}`);
                  }
                  
                  // Log action completion with failure
                  try {
                    await logger.logAction("action.completed", "scheduler", action.taskId, {
                      action: action.type,
                      success: false,
                      error: result.error,
                      errorMessage: result.error,
                    });
                  } catch (logErr) {
                    console.error(`[AOF] [BUG-003] Failed to log action.completed: ${(logErr as Error).message}`);
                  }
                  
                  // Do NOT count as executed when spawn fails (BUG-006 fix)
                  // executed remains false, mark as failed
                  failed = true;
                }
              } catch (err) {
                const error = err as Error;
                const errorMsg = error.message;
                const errorStack = error.stack ?? "No stack trace available";
                
                // BUG-003: Log exception with full stack trace
                console.error(`[AOF] [BUG-003] Exception during dispatch for task ${action.taskId}:`);
                console.error(`[AOF] [BUG-003]   Agent: ${action.agent}`);
                console.error(`[AOF] [BUG-003]   Error: ${errorMsg}`);
                console.error(`[AOF] [BUG-003]   Stack: ${errorStack}`);
                
                try {
                  await logger.logDispatch("dispatch.error", "scheduler", action.taskId, {
                    error: errorMsg,
                    errorMessage: errorMsg,
                    errorStack: errorStack,
                  });
                } catch (logErr) {
                  console.error(`[AOF] [BUG-003] Failed to log dispatch.error: ${(logErr as Error).message}`);
                }
                
                // Log action completion with exception
                try {
                  await logger.logAction("action.completed", "scheduler", action.taskId, {
                    action: action.type,
                    success: false,
                    error: errorMsg,
                    errorMessage: errorMsg,
                    errorStack: errorStack,
                  });
                } catch (logErr) {
                  console.error(`[AOF] [BUG-003] Failed to log action.completed: ${(logErr as Error).message}`);
                }
                
                // Don't count as executed if exception occurred, mark as failed
                failed = true;
              }
            }
            // If no executor, assign action is just logged (not executed)
            break;
          case "promote": {
            const { taskId, fromStatus, toStatus } = action;
            await store.transition(taskId, toStatus as TaskStatus, {
              agent: "aof-scheduler",
              reason: action.reason,
            });
            
            try {
              await logger.logTransition(
                taskId,
                fromStatus ?? "backlog",
                toStatus ?? "ready",
                "scheduler",
                action.reason
              );
            } catch {
              // Logging errors should not crash the scheduler
            }
            
            tasksPromoted++;
            
            // executed remains false - this is a status transition, not a dispatch
            break;
          }
          case "alert":
            // BUG-TELEMETRY-002: Use console.error for gateway log visibility
            // Alert actions are logged but not executed (Phase 1+: need comms adapter)
            console.error(`[AOF] ALERT: Task ${action.taskId} (${action.taskTitle}) needs routing assignment`);
            console.error(`[AOF] ALERT:   Reason: ${action.reason}`);
            console.error(`[AOF] ALERT:   Action: Manually assign via aof_dispatch --agent <agent-id> or update task routing`);
            break;
          case "sla_violation":
            // AOF-ae6: SLA violation detected
            // Log to events.jsonl
            try {
              await logger.log("sla.violation", "scheduler", {
                taskId: action.taskId,
                payload: {
                  duration: action.duration,
                  limit: action.limit,
                  agent: action.agent,
                  timestamp: Date.now(),
                },
              });
            } catch {
              // Logging errors should not crash the scheduler
            }

            // Emit alert if not rate-limited
            if (action.reason?.includes("alert will be sent")) {
              slaChecker.recordAlert(action.taskId);
              
              const durationHrs = ((action.duration ?? 0) / 3600000).toFixed(1);
              const limitHrs = ((action.limit ?? 0) / 3600000).toFixed(1);
              
              console.error(`[AOF] SLA VIOLATION: Task ${action.taskId} (${action.taskTitle})`);
              console.error(`[AOF] SLA VIOLATION:   Duration: ${durationHrs}h (limit: ${limitHrs}h)`);
              console.error(`[AOF] SLA VIOLATION:   Agent: ${action.agent ?? "unassigned"}`);
              console.error(`[AOF] SLA VIOLATION:   Action: Check if agent is stuck or task needs SLA override`);
            }
            break;
        }
        if (executed) {
          actionsExecuted++;
        }
        if (failed) {
          actionsFailed++;
        }
      } catch (err) {
        // Outer exception handler (for non-assign action failures)
        try {
          await logger.logDispatch("dispatch.error", "scheduler", action.taskId, {
            error: (err as Error).message,
          });
        } catch {
          // Logging errors should not crash the scheduler
        }
        actionsFailed++;
      }
    }
  }

  // 7. Recalculate stats after actions (reflect post-execution state)
  if (!config.dryRun && actionsExecuted > 0) {
    const updatedTasks = await store.list();
    stats.total = updatedTasks.length;
    stats.backlog = 0;
    stats.ready = 0;
    stats.inProgress = 0;
    stats.blocked = 0;
    stats.review = 0;
    stats.done = 0;

    for (const task of updatedTasks) {
      const s = task.frontmatter.status;
      if (s === "backlog") stats.backlog++;
      else if (s === "ready") stats.ready++;
      else if (s === "in-progress") stats.inProgress++;
      else if (s === "blocked") stats.blocked++;
      else if (s === "review") stats.review++;
      else if (s === "done") stats.done++;
    }
  }

  // 8. Log the poll with comprehensive metadata
  // BUG-TELEMETRY-001: Count alert actions separately
  const alertActions = actions.filter(a => a.type === "alert");
  const assignActions = actions.filter(a => a.type === "assign");
  
  const pollPayload: Record<string, unknown> = {
    dryRun: config.dryRun,
    tasksEvaluated: allTasks.length,
    tasksReady: readyTasks.length,
    actionsPlanned: actions.length,
    actionsExecuted: config.dryRun ? 0 : actionsExecuted,
    actionsFailed: config.dryRun ? 0 : actionsFailed,
    alertsRaised: alertActions.length,  // BUG-TELEMETRY-001: Include alert count
    leasesExpired: config.dryRun ? 0 : leasesExpired,  // BUG-AUDIT-004: Lease expiry count
    tasksRequeued: config.dryRun ? 0 : tasksRequeued,  // BUG-AUDIT-004: Requeue count
    tasksPromoted: config.dryRun ? 0 : tasksPromoted,  // TASK-2026-02-14: Promotion count
    stats,
  };

  // BUG-TELEMETRY-001: Improved reason mapping
  if (actionsExecuted === 0 && actions.length === 0) {
    if (allTasks.length === 0) {
      pollPayload.reason = "no_tasks";
    } else if (readyTasks.length === 0) {
      pollPayload.reason = "no_ready_tasks";
    } else {
      pollPayload.reason = "no_executable_actions";
    }
  } else if (actionsExecuted === 0 && actions.length > 0) {
    if (config.dryRun) {
      pollPayload.reason = "dry_run_mode";
    } else if (alertActions.length > 0 && assignActions.length === 0) {
      // BUG-TELEMETRY-001: Only alerts, no executable actions
      pollPayload.reason = "alert_only";
    } else if (!config.executor) {
      pollPayload.reason = "no_executor";
    } else if (actionsFailed > 0) {
      // BUG-TELEMETRY-001: Actions were attempted but failed
      pollPayload.reason = "action_failed";
    } else {
      // Fallback: should not normally reach here
      pollPayload.reason = "execution_failed";
    }
  }

  try {
    await logger.logSchedulerPoll(pollPayload);
  } catch {
    // Logging errors should not crash the scheduler
  }

  // BUG-004 fix: Add gateway log visibility for scheduler activity
  // Log poll summary to gateway log (visible in ~/.openclaw/logs/gateway.log)
  if (config.dryRun) {
    console.info(`[AOF] Scheduler poll (DRY RUN): ${stats.ready} ready, ${actions.length} actions planned, 0 dispatched`);
  } else {
    console.info(`[AOF] Scheduler poll: ${stats.ready} ready, ${actionsExecuted} dispatched, ${actionsFailed} failed`);
  }

  // Log warnings for common issues
  if (!config.dryRun && actions.length > 0 && actionsExecuted === 0) {
    if (!config.executor) {
      console.error(`[AOF] Scheduler cannot dispatch: executor is undefined (${actions.length} tasks need dispatch)`);
    } else if (actionsFailed > 0) {
      console.error(`[AOF] Scheduler dispatch failures: ${actionsFailed} tasks failed to spawn (check events.jsonl for details)`);
    }
  }

  // BUG-003: Task progression telemetry and alerting
  if (!config.dryRun && stats.total > 0) {
    // Alert when all non-done tasks are blocked
    const activeTasks = stats.total - stats.done;
    if (activeTasks > 0 && stats.blocked === activeTasks) {
      console.error(`[AOF] ALERT: All active tasks are blocked (${stats.blocked} tasks)`);
      console.error(`[AOF] ALERT: No tasks can progress - manual intervention required`);
      console.error(`[AOF] ALERT: Check blocked tasks: ls ~/.openclaw/aof/tasks/blocked/`);
    }

    // Alert when many tasks are blocked
    const blockedThreshold = 5;
    if (stats.blocked >= blockedThreshold) {
      // Find oldest blocked task
      let oldestBlockedAge = 0;
      let oldestBlockedId = "";
      for (const task of blockedTasks) {
        const lastBlockedAt = task.frontmatter.metadata?.lastBlockedAt as string | undefined;
        if (lastBlockedAt) {
          const age = Date.now() - new Date(lastBlockedAt).getTime();
          if (age > oldestBlockedAge) {
            oldestBlockedAge = age;
            oldestBlockedId = task.frontmatter.id;
          }
        }
      }

      const ageMinutes = Math.round(oldestBlockedAge / 1000 / 60);
      console.warn(`[AOF] WARNING: ${stats.blocked} tasks blocked (oldest: ${oldestBlockedId}, ${ageMinutes}min)`);
      console.warn(`[AOF] WARNING: Consider investigating dispatch failures or dependencies`);
    }

    // Alert when no successful dispatches in active mode
    if (actionsExecuted === 0 && stats.ready > 0 && actionsFailed > 0) {
      console.error(`[AOF] ALERT: No successful dispatches this poll (${stats.ready} ready, ${actionsFailed} failed)`);
      console.error(`[AOF] ALERT: Check spawnAgent API availability and agent registry`);
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    dryRun: config.dryRun,
    actions,
    stats,
  };
}
