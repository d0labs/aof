/**
 * Action execution logic for scheduler.
 *
 * Executes scheduler actions (lease expiry, promotion, dispatch, alerts, etc.)
 * and tracks execution statistics.
 */

import type { Task } from "../schemas/task.js";
import type { ITaskStore } from "../store/interfaces.js";
import { serializeTask } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import type { SchedulerConfig, SchedulerAction } from "./scheduler.js";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { executeAssignAction } from "./assign-executor.js";
import { markRunArtifactExpired, readRunResult } from "../recovery/run-artifacts.js";
import { resolveCompletionTransitions } from "../protocol/completion-utils.js";
import { cascadeOnCompletion } from "./dep-cascader.js";
import { shouldAllowSpawnFailedRequeue, DEFAULT_MAX_DISPATCH_RETRIES } from "./scheduler-helpers.js";
import { transitionToDeadletter } from "./failure-tracker.js";

export interface ActionExecutionStats {
  actionsExecuted: number;
  actionsFailed: number;
  leasesExpired: number;
  tasksRequeued: number;
  tasksPromoted: number;
  updatedConcurrencyLimit: number | null;
}

/**
 * Execute scheduler actions.
 *
 * Processes actions in sequence, handling lease expiry, task promotion,
 * dispatch, alerts, and other scheduler operations.
 *
 * @param actions - List of actions to execute
 * @param allTasks - All tasks (for dependency checking)
 * @param store - Task store
 * @param logger - Event logger
 * @param config - Scheduler config
 * @param effectiveConcurrencyLimitRef - Mutable reference to concurrency limit
 * @param metrics - Optional metrics instance
 * @returns Execution statistics
 */
export async function executeActions(
  actions: SchedulerAction[],
  allTasks: Task[],
  store: ITaskStore,
  logger: EventLogger,
  config: SchedulerConfig,
  effectiveConcurrencyLimitRef: { value: number | null },
  metrics?: import("../metrics/exporter.js").AOFMetrics
): Promise<ActionExecutionStats> {
  let actionsExecuted = 0;
  let actionsFailed = 0;
  let leasesExpired = 0;
  let tasksRequeued = 0;
  let tasksPromoted = 0;

  if (!config.dryRun) {
    for (const action of actions) {
      try {
        let executed = false;  // BUG-002 fix: only "assign" actions count as executed
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

              // BUG-AUDIT-002: For blocked tasks, check spawn failure + dependencies before requeueing
              if (expiringTask.frontmatter.status === "blocked") {
                const blockReason = expiringTask.frontmatter.metadata?.blockReason as string | undefined;
                const isSpawnFailed = blockReason?.includes("spawn_failed") ?? false;

                if (isSpawnFailed) {
                  // Spawn-failed task: use shared guard to prevent infinite retry loop
                  const maxRetries = config.maxDispatchRetries ?? DEFAULT_MAX_DISPATCH_RETRIES;
                  const guard = shouldAllowSpawnFailedRequeue(expiringTask, maxRetries);

                  if (guard.shouldDeadletter) {
                    const lastError = (expiringTask.frontmatter.metadata?.lastError as string) ?? blockReason ?? "unknown";
                    await transitionToDeadletter(store, logger, action.taskId, lastError);
                    try {
                      await logger.logTransition(action.taskId, "blocked", "deadletter", "scheduler",
                        `Lease expired on spawn-failed task — ${guard.reason}`);
                    } catch {
                      // Logging errors should not crash the scheduler
                    }
                  } else if (guard.allow) {
                    await store.transition(action.taskId, "ready", {
                      reason: "lease_expired_spawn_retry"
                    });
                    try {
                      await logger.logTransition(action.taskId, "blocked", "ready", "scheduler",
                        `Lease expired — ${guard.reason}`);
                    } catch {
                      // Logging errors should not crash the scheduler
                    }
                  } else {
                    // Backoff not elapsed — stay blocked, just clear the lease
                    console.info(`[AOF] Lease expired on spawn-failed task ${action.taskId} — backoff pending (${guard.reason})`);
                  }
                } else {
                  // Non-spawn-failure blocked task: check dependencies
                  const deps = expiringTask.frontmatter.dependsOn ?? [];
                  const allDepsResolved = deps.length === 0 || deps.every(depId => {
                    const dep = allTasks.find(t => t.frontmatter.id === depId);
                    return dep?.frontmatter.status === "done";
                  });

                  if (allDepsResolved) {
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
                    console.warn(`[AOF] Lease expired on blocked task ${action.taskId} but dependencies not satisfied - staying blocked`);
                  }
                }
              } else {
                // In-progress task - transition back to ready
                await store.transition(action.taskId, "ready", { reason: "lease_expired" });

                try {
                  await logger.logTransition(action.taskId, "in-progress", "ready", "scheduler",
                    `Lease expired - task requeued`);
                } catch {
                  // Logging errors should not crash the scheduler
                }
              }
              leasesExpired++;
              tasksRequeued++;  // BUG-AUDIT-004: Count both requeue paths
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

            // Read correlation ID from task metadata for event logging
            const staleCorrelationId = staleTask.frontmatter.metadata?.correlationId as string | undefined;

            // If adapter available and session ID known, use adapter for force-completion
            const staleSessionId = staleTask.frontmatter.metadata?.sessionId as string | undefined;
            if (config.executor && staleSessionId) {
              try {
                await config.executor.forceCompleteSession(staleSessionId);
                console.info(`[AOF] Force-completed session ${staleSessionId} for task ${action.taskId}`);

                // Log session force-completion event
                try {
                  await logger.log("session.force_completed", "scheduler", {
                    taskId: action.taskId,
                    payload: { sessionId: staleSessionId, correlationId: staleCorrelationId, reason: "stale_heartbeat" },
                  });
                } catch {
                  // Logging errors should not crash the scheduler
                }
              } catch (err) {
                console.warn(`[AOF] forceCompleteSession failed for ${staleSessionId}: ${(err as Error).message}`);
                // Continue with existing recovery logic even if force-complete fails
              }
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

              if (runResult.outcome === "done") {
                try {
                  await cascadeOnCompletion(action.taskId, store, logger);
                } catch (err) {
                  console.error(`[AOF] cascadeOnCompletion failed for ${action.taskId}:`, err);
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

          case "promote":
            await store.transition(action.taskId, "ready", { reason: "dependency_satisfied" });
            try {
              await logger.logTransition(action.taskId, "backlog", "ready", "scheduler",
                action.reason ?? "All dependencies satisfied");
            } catch {
              // Logging errors should not crash the scheduler
            }
            tasksPromoted++;
            // BUG-002 fix: Don't count non-dispatch actions in actionsExecuted
            // executed remains false
            break;

          case "assign":
            // AOF-8s8: Use extracted executor for assign actions
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
            break;

          case "deadletter": {
            const lastError = action.reason ?? "unknown";
            await transitionToDeadletter(store, logger, action.taskId, lastError);
            // executed remains false — deadletter is not a dispatch
            break;
          }

          case "alert":
            // Alerts are logged but not executed (notification target)
            console.warn(`[AOF] ${action.type.toUpperCase()}: ${action.reason}`);
            try {
              await logger.log("scheduler_alert", "scheduler", {
                taskId: action.taskId,
                payload: {
                  agent: action.agent,
                  reason: action.reason,
                },
              });
            } catch {
              // Logging errors should not crash the scheduler
            }
            // BUG-002 fix: Don't count non-dispatch actions in actionsExecuted
            // executed remains false
            break;

          case "block":
            await store.transition(action.taskId, "blocked", {
              reason: action.reason,
              blockers: action.blockers,
            });
            try {
              await logger.logTransition(action.taskId, "ready", "blocked", "scheduler",
                action.reason);
            } catch {
              // Logging errors should not crash the scheduler
            }
            // BUG-002 fix: Don't count non-dispatch actions in actionsExecuted
            // executed remains false
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
              config.slaChecker?.recordAlert(action.taskId);
              
              const durationHrs = ((action.duration ?? 0) / 3600000).toFixed(1);
              const limitHrs = ((action.limit ?? 0) / 3600000).toFixed(1);
              
              console.error(`[AOF] SLA VIOLATION: Task ${action.taskId} (${action.taskTitle})`);
              console.error(`[AOF] SLA VIOLATION:   Duration: ${durationHrs}h (limit: ${limitHrs}h)`);
              console.error(`[AOF] SLA VIOLATION:   Agent: ${action.agent ?? "unassigned"}`);
              console.error(`[AOF] SLA VIOLATION:   Action: Check if agent is stuck or task needs SLA override`);
            }
            // BUG-002 fix: Don't count non-dispatch actions in actionsExecuted
            // executed remains false
            break;
            
          case "murmur_create_task":
            // AOF-yea: Create a review task for approved Murmur candidate
            try {
              // The action object is already formatted by evaluateMurmurTriggers
              // It contains: type, taskId, agent, reason (and fields for createTask)
              console.log(`[AOF] Murmur orchestration: creating review task for ${action.sourceTaskId}`);
              await logger.log("murmur_task_created", "scheduler", {
                taskId: action.taskId,
                payload: {
                  sourceTaskId: action.sourceTaskId,
                  murmurCandidateId: action.murmurCandidateId,
                  agent: action.agent,
                },
              });
              // BUG-002 fix: Don't count non-dispatch actions in actionsExecuted
              // executed remains false
            } catch (err) {
              const error = err as Error;
              console.error(`[AOF] Failed to create Murmur review task for ${action.sourceTaskId}: ${error.message}`);
              failed = true;
            }
            break;

          default:
            console.warn(`[AOF] Unknown action type: ${(action as SchedulerAction).type}`);
            failed = true;
        }

        if (executed) {
          actionsExecuted++;
        }
        if (failed) {
          actionsFailed++;
        }
      } catch (err) {
        const error = err as Error;
        console.error(`[AOF] Failed to execute action for ${action.taskId}: ${error.message}`);
        try {
          await logger.log("scheduler_action_failed", "scheduler", {
            taskId: action.taskId,
            payload: {
              type: action.type,
              error: error.message,
            },
          });
        } catch {
          // Logging errors should not crash the scheduler
        }
        actionsFailed++;
      }
    }
  }

  return {
    actionsExecuted,
    actionsFailed,
    leasesExpired,
    tasksRequeued,
    tasksPromoted,
    updatedConcurrencyLimit: effectiveConcurrencyLimitRef.value,
  };
}
