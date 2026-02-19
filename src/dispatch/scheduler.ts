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
import { readFileSync } from "node:fs";
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
import { escalateGateTimeout, checkGateTimeouts } from "./escalation.js";
import { buildDispatchActions } from "./task-dispatcher.js";
import { checkPromotionEligibility } from "./promotion.js";
import { executeActions } from "./action-executor.js";
import { buildTaskStats, buildChildrenMap, checkExpiredLeases, buildResourceOccupancyMap, checkBacklogPromotion, checkBlockedTaskRecovery } from "./scheduler-helpers.js";

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
  type: "expire_lease" | "assign" | "requeue" | "block" | "deadletter" | "alert" | "stale_heartbeat" | "sla_violation" | "promote" | "murmur_create_task";
  taskId: string;
  taskTitle: string;
  agent?: string;
  reason: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;  // For promote actions
  duration?: number;  // For SLA violations: actual duration
  limit?: number;     // For SLA violations: SLA limit
  sourceTaskId?: string;
  murmurCandidateId?: string;
  blockers?: string[];
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

  const childrenByParent = buildChildrenMap(allTasks);
  const stats = buildTaskStats(allTasks);

  // 3. Check for expired leases (BUG-AUDIT-001: check both in-progress AND blocked)
  const expiredLeaseActions = checkExpiredLeases(allTasks);
  actions.push(...expiredLeaseActions);

  // 3.5. Build resource occupancy map (TASK-054: resource serialization)
  const occupiedResources = buildResourceOccupancyMap(allTasks);
  const inProgressTasks = allTasks.filter(t => t.frontmatter.status === "in-progress");

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
  let projectManifest: Record<string, unknown> = {};
  const projectYamlPath = join(config.dataDir, "project.yaml");
  try {
    const projectYamlContent = readFileSync(projectYamlPath, "utf8");
    projectManifest = parseYaml(projectYamlContent) ?? {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[AOF] Failed to parse project.yaml at ${projectYamlPath}: ${(err as Error).message}`);
    }
  }
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
  const promotionActions = checkBacklogPromotion(allTasks, childrenByParent, checkPromotionEligibility);
  actions.push(...promotionActions);

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
  const recoveryActions = checkBlockedTaskRecovery(allTasks, childrenByParent);
  actions.push(...recoveryActions);
  // 6. Execute actions (only in active mode)
  const effectiveConcurrencyLimitRef = { value: effectiveConcurrencyLimit };
  const executionStats = await executeActions(
    actions,
    allTasks,
    store,
    logger,
    config,
    effectiveConcurrencyLimitRef,
    metrics
  );
  
  const actionsExecuted = executionStats.actionsExecuted;
  const actionsFailed = executionStats.actionsFailed;
  const leasesExpired = executionStats.leasesExpired;
  const tasksRequeued = executionStats.tasksRequeued;
  const tasksPromoted = executionStats.tasksPromoted;
  effectiveConcurrencyLimit = executionStats.updatedConcurrencyLimit;

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
      const blockedTasks = allTasks.filter(t => t.frontmatter.status === "blocked");
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
              taskId: undefined,
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
        taskId: undefined,
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
