/**
 * Deterministic Scheduler — scans tasks and dispatches work.
 *
 * Phase 0: dry-run mode only (logs what it would do, no mutations).
 * No LLM calls. Filesystem I/O only.
 */

import { FilesystemTaskStore, serializeTask } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { acquireLease, expireLeases, releaseLease } from "../store/lease.js";
import { checkStaleHeartbeats, markRunArtifactExpired, readRunResult } from "../recovery/run-artifacts.js";
import { resolveCompletionTransitions } from "../protocol/completion-utils.js";
import { SLAChecker } from "./sla-checker.js";
import { join, relative } from "node:path";
import { readFile, access } from "node:fs/promises";
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
import { evaluateMurmurTriggers } from "./murmur-integration.js";
import { loadOrgChart } from "../org/loader.js";
import { checkThrottle, updateThrottleState, resetThrottleState as resetThrottleStateInternal } from "./throttle.js";
import { isLeaseActive, startLeaseRenewal, stopLeaseRenewal, cleanupLeaseRenewals } from "./lease-manager.js";
import { escalateGateTimeout } from "./escalation.js";
import { executeAssignAction, buildDispatchActions } from "./task-dispatcher.js";
import { checkPromotionEligibility } from "./promotion.js";

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
  /** Minimum interval between dispatches in milliseconds (default: 5000). */
  minDispatchIntervalMs?: number;
  /** Maximum dispatches per poll cycle (default: 2). */
  maxDispatchesPerPoll?: number;
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

/**
 * Effective concurrency limit — auto-detected from OpenClaw platform limit.
 * Starts null, set to min(platformLimit, config.maxConcurrentDispatches) when detected.
 */
let effectiveConcurrencyLimit: number | null = null;

/** Reset throttle state (for testing). */
export function resetThrottleState(): void {
  resetThrottleStateInternal();
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

  // 4. Check for ready tasks that can be assigned (AOF-8s8: extracted to task-dispatcher.ts)
  const readyTasks = allTasks.filter(t => t.frontmatter.status === "ready");
  const dispatchActions = await buildDispatchActions(
    readyTasks,
    allTasks,
    store,
    config,
    {
      currentInProgress: stats.inProgress,
      blockedBySubtasks,
      circularDeps,
      occupiedResources,
      inProgressTasks,
    },
    effectiveConcurrencyLimit,
    childrenByParent
  );
  actions.push(...dispatchActions);

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
          case "assign": {
            // AOF-8s8: Extracted to task-dispatcher.ts
            const effectiveConcurrencyLimitRef = { value: effectiveConcurrencyLimit };
            const result = await executeAssignAction(
              action,
              store,
              logger,
              config,
              allTasks,
              effectiveConcurrencyLimitRef
            );
            executed = result.executed;
            failed = result.failed;
            effectiveConcurrencyLimit = effectiveConcurrencyLimitRef.value;
            break;
          }
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

  // 9. AOF-yea: Murmur orchestration review evaluation
  // Runs after normal dispatch cycle to evaluate triggers and create review tasks
  try {
    // Load org chart to get team configurations
    const orgChartPath = join(config.dataDir, "org.yaml");
    let orgChartExists = true;
    try {
      await access(orgChartPath);
    } catch {
      orgChartExists = false;
    }

    if (orgChartExists) {
      const orgChartResult = await loadOrgChart(orgChartPath);
      
      if (orgChartResult.success && orgChartResult.chart) {
        const teams = orgChartResult.chart.teams ?? [];
        
        // Evaluate murmur triggers for teams with orchestrator config
        const murmurResult = await evaluateMurmurTriggers(teams, {
          store,
          logger,
          executor: config.executor,
          dryRun: config.dryRun,
          defaultLeaseTtlMs: config.defaultLeaseTtlMs,
          spawnTimeoutMs: config.spawnTimeoutMs ?? 30_000,
          maxConcurrentDispatches: effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3,
          currentInProgress: stats.inProgress,
        });
        
        // Log murmur evaluation results
        if (murmurResult.teamsEvaluated > 0) {
          try {
            await logger.log("murmur.poll", "scheduler", {
              taskId: null,
              payload: {
                teamsEvaluated: murmurResult.teamsEvaluated,
                reviewsTriggered: murmurResult.reviewsTriggered,
                reviewsDispatched: murmurResult.reviewsDispatched,
                reviewsFailed: murmurResult.reviewsFailed,
                reviewsSkipped: murmurResult.reviewsSkipped,
              },
            });
          } catch {
            // Logging errors should not crash the scheduler
          }
        }
      }
    }
  } catch (error) {
    // Murmur evaluation errors should not crash the scheduler
    console.error(`[AOF] Murmur evaluation failed: ${(error as Error).message}`);
    try {
      await logger.log("murmur.evaluation.failed", "scheduler", {
        taskId: null,
        payload: {
          error: (error as Error).message,
        },
      });
    } catch {
      // Logging errors should not crash the scheduler
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
