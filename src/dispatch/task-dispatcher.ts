/**
 * Task Dispatcher — handles ready task dispatch execution.
 * 
 * Extracted from scheduler.ts (AOF-8s8) to reduce file size and improve modularity.
 * 
 * Responsibilities:
 * - Iterate ready tasks and check dispatch eligibility (deps, leases, throttles)
 * - Build assign/alert actions for eligible tasks
 * - Execute assign actions (lease acquisition, executor.spawn, lease renewal)
 * - Handle dispatch failures and retry logic
 */

import type { Task, TaskStatus } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { DispatchExecutor, TaskContext } from "./executor.js";
import { acquireLease, releaseLease } from "../store/lease.js";
import { isLeaseActive, startLeaseRenewal } from "./lease-manager.js";
import { checkThrottle, updateThrottleState } from "./throttle.js";
import { serializeTask } from "../store/task-store.js";
import { buildGateContext } from "./gate-context-builder.js";
import { loadOrgChart } from "../org/loader.js";
import { join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import writeFileAtomic from "write-file-atomic";
import { ProjectManifest } from "../schemas/project.js";

export interface DispatchConfig {
  dryRun: boolean;
  defaultLeaseTtlMs: number;
  spawnTimeoutMs?: number;
  executor?: DispatchExecutor;
  maxConcurrentDispatches?: number;
  minDispatchIntervalMs?: number;
  maxDispatchesPerPoll?: number;
}

export interface SchedulerAction {
  type: "expire_lease" | "assign" | "requeue" | "block" | "deadletter" | "alert" | "stale_heartbeat" | "sla_violation" | "promote";
  taskId: string;
  taskTitle: string;
  agent?: string;
  reason: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;
  duration?: number;
  limit?: number;
}

export interface DispatchMetrics {
  currentInProgress: number;
  pendingDispatches: number;
  blockedBySubtasks: Set<string>;
  circularDeps: Set<string>;
  occupiedResources: Map<string, string>;
  effectiveConcurrencyLimit: number | null;
}

export interface DispatchResult {
  actions: SchedulerAction[];
  actionsExecuted: number;
  actionsFailed: number;
}

/**
 * Load project manifest from disk.
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
 * Execute a single assign action: acquire lease, spawn agent, handle errors.
 * 
 * @param action - Assign action to execute
 * @param store - Task store
 * @param logger - Event logger
 * @param config - Dispatch configuration
 * @param allTasks - All tasks in the system (for context lookup)
 * @param effectiveConcurrencyLimitRef - Reference to effective concurrency limit (mutable)
 * @returns { executed: boolean, failed: boolean }
 */
export async function executeAssignAction(
  action: SchedulerAction,
  store: ITaskStore,
  logger: EventLogger,
  config: DispatchConfig,
  allTasks: Task[],
  effectiveConcurrencyLimitRef: { value: number | null }
): Promise<{ executed: boolean; failed: boolean }> {
  let executed = false;
  let failed = false;

  // BUG-003: Log when executor is missing (but don't count as failed - nothing was attempted)
  if (!config.executor) {
    console.error(`[AOF] [BUG-003] Cannot dispatch task ${action.taskId}: executor is undefined`);
    console.error(`[AOF] [BUG-003]   Agent: ${action.agent}`);
    console.error(`[AOF] [BUG-003]   Task will remain in ready/ until executor is configured`);
    return { executed, failed };
  }

  try {
    const latest = await store.get(action.taskId);
    if (!latest) {
      console.warn(`[AOF] [TASK-056] Task ${action.taskId} not found, skipping dispatch`);
      return { executed, failed };
    }

    if (latest.frontmatter.status !== "ready") {
      console.warn(
        `[AOF] [TASK-056] Dispatch dedup: skipping ${action.taskId} (status ${latest.frontmatter.status})`,
      );
      return { executed, failed };
    }

    if (isLeaseActive(latest.frontmatter.lease)) {
      const lease = latest.frontmatter.lease;
      console.warn(
        `[AOF] [TASK-056] Dispatch dedup: skipping ${action.taskId} (active lease held by ${lease?.agent} until ${lease?.expiresAt})`,
      );
      return { executed, failed };
    }

    const task = allTasks.find(t => t.frontmatter.id === action.taskId);
    if (!task) {
      console.warn(`[AOF] [BUG-001] Task ${action.taskId} not found in allTasks, skipping dispatch`);
      return { executed, failed };
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
      
      // AOF-adf: Update throttle state after successful dispatch
      const dispatchedTask = await store.get(action.taskId);
      if (dispatchedTask) {
        const dispatchTeam = dispatchedTask.frontmatter.routing.team;
        updateThrottleState(dispatchTeam);
      }
    } else {
      // Check if this is a platform concurrency limit error
      if (result.platformLimit !== undefined) {
        const previousCap = effectiveConcurrencyLimitRef.value ?? config.maxConcurrentDispatches ?? 3;
        effectiveConcurrencyLimitRef.value = Math.min(result.platformLimit, config.maxConcurrentDispatches ?? 3);
        
        console.info(
          `[AOF] Platform concurrency limit detected: ${result.platformLimit}, ` +
          `effective cap now ${effectiveConcurrencyLimitRef.value} (was ${previousCap})`
        );
        
        // Emit event (non-fatal if logging fails)
        try {
          await logger.log("concurrency.platformLimit", "scheduler", {
            taskId: action.taskId,
            payload: {
              detectedLimit: result.platformLimit,
              effectiveCap: effectiveConcurrencyLimitRef.value,
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
        
        return { executed, failed };
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

  return { executed, failed };
}

/**
 * Build dispatch actions for ready tasks.
 * 
 * Checks dependencies, leases, throttles, and creates assign/alert/block actions.
 * 
 * @param readyTasks - Tasks in ready status
 * @param allTasks - All tasks in the system
 * @param store - Task store
 * @param config - Dispatch configuration
 * @param metrics - Dispatch metrics (concurrency, blocked tasks, occupied resources)
 * @param effectiveConcurrencyLimit - Current effective concurrency limit
 * @param childrenByParent - Map of parent task ID to child tasks
 * @returns Array of scheduler actions to execute
 */
export async function buildDispatchActions(
  readyTasks: Task[],
  allTasks: Task[],
  store: ITaskStore,
  config: DispatchConfig,
  metrics: {
    currentInProgress: number;
    blockedBySubtasks: Set<string>;
    circularDeps: Set<string>;
    occupiedResources: Map<string, string>;
    inProgressTasks: Task[];
  },
  effectiveConcurrencyLimit: number | null,
  childrenByParent: Map<string, Task[]>
): Promise<SchedulerAction[]> {
  const actions: SchedulerAction[] = [];
  
  const maxDispatches = effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3;
  const currentInProgress = metrics.currentInProgress;
  let pendingDispatches = 0;
  
  // AOF-adf: Load org chart for per-team throttling
  let orgChart: Awaited<ReturnType<typeof loadOrgChart>> | null = null;
  try {
    const orgChartPath = join(store.projectRoot, "org-chart.yaml");
    const result = await loadOrgChart(orgChartPath);
    if (result.success) {
      orgChart = result;
    }
  } catch (err) {
    // Org chart is optional - continue without per-team overrides
  }
  
  // AOF-adf: Build team configuration map
  const teamConfigMap = new Map<string, { maxConcurrent?: number; minIntervalMs?: number }>();
  if (orgChart?.chart?.teams) {
    for (const team of orgChart.chart.teams) {
      if (team.dispatch) {
        teamConfigMap.set(team.id, {
          maxConcurrent: team.dispatch.maxConcurrent,
          minIntervalMs: team.dispatch.minIntervalMs,
        });
      }
    }
  }
  
  // AOF-adf: Track in-progress tasks by team
  const inProgressByTeam = new Map<string, number>();
  for (const task of metrics.inProgressTasks) {
    const team = task.frontmatter.routing.team;
    if (team) {
      inProgressByTeam.set(team, (inProgressByTeam.get(team) ?? 0) + 1);
    }
  }
  
  // AOF-adf: Throttle config with defaults (conservative - opt-in)
  const minDispatchIntervalMs = config.minDispatchIntervalMs ?? 0; // 0 = disabled
  const maxDispatchesPerPoll = config.maxDispatchesPerPoll ?? 10; // 10 = effectively disabled
  let dispatchesThisPoll = 0;
  
  // Log concurrency status
  console.info(
    `[AOF] Concurrency limit: ${currentInProgress}/${maxDispatches} in-progress` +
    (effectiveConcurrencyLimit !== null ? ` (platform-adjusted from ${config.maxConcurrentDispatches ?? 3})` : "")
  );
  
  for (const task of readyTasks) {
    if (metrics.blockedBySubtasks.has(task.frontmatter.id)) continue;
    
    // TASK-055: Check for circular dependencies - block if detected
    if (metrics.circularDeps.has(task.frontmatter.id)) {
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
    if (resource && metrics.occupiedResources.has(resource)) {
      const occupyingTaskId = metrics.occupiedResources.get(resource)!;
      console.warn(`[AOF] Resource lock: skipping ${task.frontmatter.id} (resource "${resource}" occupied by ${occupyingTaskId})`);
      continue;
    }
    
    // AOF-adf: Throttle checks
    const routing = task.frontmatter.routing;
    const team = routing.team;
    
    // Get team config
    const teamConfig = team && teamConfigMap.has(team) ? teamConfigMap.get(team)! : undefined;
    const teamInProgress = team ? (inProgressByTeam.get(team) ?? 0) : undefined;
    
    const throttleCheck = checkThrottle({
      taskId: task.frontmatter.id,
      team,
      currentInProgress,
      pendingDispatches,
      maxDispatches,
      teamInProgress,
      teamMaxConcurrent: teamConfig?.maxConcurrent,
      minDispatchIntervalMs: minDispatchIntervalMs > 0 ? minDispatchIntervalMs : undefined,
      teamMinIntervalMs: teamConfig?.minIntervalMs,
      dispatchesThisPoll,
      maxDispatchesPerPoll,
    });
    
    if (!throttleCheck.allowed) {
      console.info(`[AOF] Dispatch throttled: ${task.frontmatter.id} (${throttleCheck.reason})`);
      // If global interval not elapsed, throttle ALL remaining tasks in this poll
      if (throttleCheck.reason?.includes("global interval")) {
        break;
      }
      continue;
    }
    
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
      dispatchesThisPoll++; // AOF-adf: Track dispatches this poll cycle
      
      // AOF-adf: Reserve team concurrency slot for this planned dispatch
      if (team && !config.dryRun) {
        inProgressByTeam.set(team, (inProgressByTeam.get(team) ?? 0) + 1);
      }
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

  // Block parents with incomplete subtasks
  for (const task of allTasks) {
    if (!metrics.blockedBySubtasks.has(task.frontmatter.id)) continue;
    if (task.frontmatter.status === "blocked" || task.frontmatter.status === "done") continue;

    actions.push({
      type: "block",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      reason: "Parent task has incomplete subtasks",
      fromStatus: task.frontmatter.status,
    });
  }

  return actions;
}
