/**
 * Murmur scheduler integration — orchestration review evaluation and dispatch.
 *
 * Evaluates murmur triggers for teams with orchestrator configuration.
 * Creates and dispatches review tasks when triggers fire.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";
import type { GatewayAdapter, TaskContext } from "./executor.js";
import type { OrgTeam } from "../schemas/org-chart.js";
import { MurmurStateManager } from "../murmur/state-manager.js";
import { evaluateTriggers } from "../murmur/trigger-evaluator.js";
import { buildReviewContext } from "../murmur/context-builder.js";
import { cleanupStaleReview } from "../murmur/cleanup.js";
import { relative, join } from "node:path";
import { acquireLease } from "../store/lease.js";

export interface MurmurIntegrationOptions {
  /** Task store for creating review tasks. */
  store: ITaskStore;
  /** Event logger for murmur events. */
  logger: EventLogger;
  /** Executor for dispatching review tasks (optional, dry-run if absent). */
  executor?: GatewayAdapter;
  /** State manager for murmur state persistence. */
  stateManager?: MurmurStateManager;
  /** Dry-run mode: log decisions but don't mutate state. */
  dryRun: boolean;
  /** Default lease TTL for review tasks. */
  defaultLeaseTtlMs: number;
  /** Spawn timeout for review tasks. */
  spawnTimeoutMs?: number;
  /** Review timeout for stale review cleanup (default: 30 minutes). */
  reviewTimeoutMs?: number;
  /** Maximum concurrent in-progress tasks (for concurrency check). */
  maxConcurrentDispatches: number;
  /** Current in-progress task count. */
  currentInProgress: number;
}

export interface MurmurEvaluationResult {
  teamsEvaluated: number;
  reviewsTriggered: number;
  reviewsSkipped: number;
  reviewsDispatched: number;
  reviewsFailed: number;
}

/**
 * Evaluate murmur triggers for all teams and dispatch reviews if needed.
 *
 * Called after the scheduler's normal dispatch cycle.
 * Evaluates triggers for teams with murmur config, creates review tasks,
 * and dispatches them to orchestrator agents.
 */
export async function evaluateMurmurTriggers(
  teams: OrgTeam[],
  options: MurmurIntegrationOptions
): Promise<MurmurEvaluationResult> {
  const {
    store,
    logger,
    executor,
    dryRun,
    defaultLeaseTtlMs,
    spawnTimeoutMs = 30_000,
    reviewTimeoutMs = 30 * 60 * 1000, // 30 minutes default
    maxConcurrentDispatches,
    currentInProgress,
  } = options;

  const stateManager =
    options.stateManager ??
    new MurmurStateManager({
      stateDir: join(store.projectRoot, ".murmur"),
    });

  const result: MurmurEvaluationResult = {
    teamsEvaluated: 0,
    reviewsTriggered: 0,
    reviewsSkipped: 0,
    reviewsDispatched: 0,
    reviewsFailed: 0,
  };

  // Filter teams with murmur config
  const teamsWithMurmur = teams.filter(
    (team) => team.murmur && team.orchestrator
  );

  if (teamsWithMurmur.length === 0) {
    return result;
  }

  // Get task stats for all tasks
  const allTasks = await store.list();
  const tasksByTeam = new Map<string, typeof allTasks>();

  for (const task of allTasks) {
    const team = task.frontmatter.routing.team;
    if (!team) continue;
    const list = tasksByTeam.get(team) ?? [];
    list.push(task);
    tasksByTeam.set(team, list);
  }

  // Evaluate triggers for each team
  for (const team of teamsWithMurmur) {
    result.teamsEvaluated++;

    try {
      // Load murmur state
      const state = await stateManager.load(team.id);

      // Check for stale review and clean up if needed
      await cleanupStaleReview(team.id, state, store, stateManager, logger, {
        reviewTimeoutMs,
        dryRun,
      });

      // Get task stats for this team
      const teamTasks = tasksByTeam.get(team.id) ?? [];
      const readyCount = teamTasks.filter(
        (t) => t.frontmatter.status === "ready"
      ).length;
      const inProgressCount = teamTasks.filter(
        (t) => t.frontmatter.status === "in-progress"
      ).length;

      const taskStats = {
        ready: readyCount,
        inProgress: inProgressCount,
      };

      // Evaluate triggers
      const triggerResult = evaluateTriggers(
        team.murmur!.triggers,
        state,
        taskStats
      );

      if (!triggerResult.shouldFire) {
        // No trigger fired or review already in progress
        if (state.currentReviewTaskId !== null) {
          console.info(
            `[AOF] Murmur: skipping ${team.id} (review ${state.currentReviewTaskId} in progress)`
          );
        }
        result.reviewsSkipped++;
        continue;
      }

      console.info(
        `[AOF] Murmur: trigger fired for ${team.id} (${triggerResult.triggeredBy}): ${triggerResult.reason}`
      );
      result.reviewsTriggered++;

      // Check concurrency limit before dispatching
      if (currentInProgress >= maxConcurrentDispatches) {
        console.info(
          `[AOF] Murmur: skipping ${team.id} (concurrency limit ${currentInProgress}/${maxConcurrentDispatches})`
        );
        result.reviewsSkipped++;

        // Log event
        try {
          await logger.log("murmur.trigger.skipped", "scheduler", {
            taskId: undefined,
            payload: {
              team: team.id,
              reason: "concurrency_limit",
              triggeredBy: triggerResult.triggeredBy,
              currentInProgress,
              maxConcurrentDispatches,
            },
          });
        } catch {
          // Logging errors should not crash the scheduler
        }

        continue;
      }

      // Don't mutate in dry-run mode
      if (dryRun) {
        console.info(
          `[AOF] Murmur: would create review task for ${team.id} (dry-run)`
        );
        continue;
      }

      // Build review context
      const reviewContext = await buildReviewContext(team, state, store);

      // Create murmur review task
      let reviewTask = await store.create({
        title: `Orchestration Review: ${team.name}`,
        body: reviewContext,
        priority: "high",
        routing: {
          agent: team.orchestrator,
          team: team.id,
        },
        metadata: {
          kind: "orchestration_review",
          murmurTrigger: triggerResult.triggeredBy,
          murmurReason: triggerResult.reason,
        },
        createdBy: "aof-scheduler",
      });

      // Transition to ready so it can be dispatched
      reviewTask = await store.transition(reviewTask.frontmatter.id, "ready", {
        reason: "murmur_review_created",
      });

      console.info(
        `[AOF] Murmur: created review task ${reviewTask.frontmatter.id} for ${team.id}`
      );

      // Update murmur state (start review)
      await stateManager.startReview(
        team.id,
        reviewTask.frontmatter.id,
        triggerResult.triggeredBy!
      );

      // Log event
      try {
        await logger.log("murmur.review.created", "scheduler", {
          taskId: reviewTask.frontmatter.id,
          payload: {
            team: team.id,
            triggeredBy: triggerResult.triggeredBy,
            reason: triggerResult.reason,
            orchestrator: team.orchestrator,
          },
        });
      } catch {
        // Logging errors should not crash the scheduler
      }

      // Dispatch review task if executor is available
      if (!executor) {
        console.warn(
          `[AOF] Murmur: executor unavailable, review task ${reviewTask.frontmatter.id} will be picked up by normal dispatch`
        );
        continue;
      }

      try {
        // Acquire lease and build context
        const leasedTask = await acquireLease(
          store,
          reviewTask.frontmatter.id,
          team.orchestrator!,
          { ttlMs: defaultLeaseTtlMs }
        );

        const taskPath =
          leasedTask?.path ??
          join(
            store.tasksDir,
            "in-progress",
            `${reviewTask.frontmatter.id}.md`
          );

        const context: TaskContext = {
          taskId: reviewTask.frontmatter.id,
          taskPath,
          agent: team.orchestrator!,
          priority: reviewTask.frontmatter.priority,
          routing: reviewTask.frontmatter.routing,
          projectId: store.projectId,
          projectRoot: store.projectRoot,
          taskRelpath: relative(store.projectRoot, taskPath),
        };

        // Spawn agent session
        const spawnResult = await executor.spawnSession(context, {
          timeoutMs: spawnTimeoutMs,
        });

        if (spawnResult.success) {
          console.info(
            `[AOF] Murmur: dispatched review task ${reviewTask.frontmatter.id} to ${team.orchestrator}`
          );
          result.reviewsDispatched++;

          try {
            await logger.log("murmur.review.dispatched", "scheduler", {
              taskId: reviewTask.frontmatter.id,
              payload: {
                team: team.id,
                orchestrator: team.orchestrator,
                sessionId: spawnResult.sessionId,
              },
            });
          } catch {
            // Logging errors should not crash the scheduler
          }
        } else {
          console.error(
            `[AOF] Murmur: failed to dispatch review task ${reviewTask.frontmatter.id}: ${spawnResult.error}`
          );
          result.reviewsFailed++;

          try {
            await logger.log("murmur.review.dispatch_failed", "scheduler", {
              taskId: reviewTask.frontmatter.id,
              payload: {
                team: team.id,
                orchestrator: team.orchestrator,
                error: spawnResult.error,
              },
            });
          } catch {
            // Logging errors should not crash the scheduler
          }

          // Transition back to ready so normal dispatch can retry
          await store.transition(reviewTask.frontmatter.id, "ready", {
            reason: "murmur_dispatch_failed",
          });
        }
      } catch (error) {
        console.error(
          `[AOF] Murmur: exception dispatching review task ${reviewTask.frontmatter.id}: ${(error as Error).message}`
        );
        result.reviewsFailed++;

        try {
          await logger.log("murmur.review.dispatch_error", "scheduler", {
            taskId: reviewTask.frontmatter.id,
            payload: {
              team: team.id,
              error: (error as Error).message,
            },
          });
        } catch {
          // Logging errors should not crash the scheduler
        }
      }
    } catch (error) {
      console.error(
        `[AOF] Murmur: error evaluating team ${team.id}: ${(error as Error).message}`
      );

      try {
        await logger.log("murmur.evaluation.error", "scheduler", {
          taskId: undefined,
          payload: {
            team: team.id,
            error: (error as Error).message,
          },
        });
      } catch {
        // Logging errors should not crash the scheduler
      }
    }
  }

  // Log summary
  console.info(
    `[AOF] Murmur evaluation: ${result.teamsEvaluated} teams, ` +
      `${result.reviewsTriggered} triggered, ` +
      `${result.reviewsDispatched} dispatched, ` +
      `${result.reviewsFailed} failed`
  );

  return result;
}
