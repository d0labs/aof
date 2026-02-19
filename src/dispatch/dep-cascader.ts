/**
 * Dependency cascade module.
 *
 * When a task transitions to "done" or "blocked", immediately cascade the
 * status change to direct dependents without waiting for the next scheduler poll.
 *
 * Both functions are pure/deterministic — no LLM calls.
 */

import type { ITaskStore } from "../store/interfaces.js";
import type { EventLogger } from "../events/logger.js";

export interface CascadeResult {
  /** Task IDs promoted from backlog/blocked → ready */
  promoted: string[];
  /** Task IDs blocked via cascade */
  blocked: string[];
  /** Task IDs with other unmet deps — no action taken */
  skipped: string[];
}

/**
 * Called after a task transitions to "done".
 *
 * Finds all direct dependents in backlog/blocked state and promotes those
 * whose remaining deps are all satisfied (status === "done") to ready.
 *
 * Emits one `dependency.cascaded` event summarising the operation.
 */
export async function cascadeOnCompletion(
  completedTaskId: string,
  store: ITaskStore,
  logger: EventLogger,
): Promise<CascadeResult> {
  const result: CascadeResult = { promoted: [], blocked: [], skipped: [] };

  const allTasks = await store.list();

  const dependents = allTasks.filter(
    (t) =>
      (t.frontmatter.dependsOn ?? []).includes(completedTaskId) &&
      (t.frontmatter.status === "backlog" || t.frontmatter.status === "blocked"),
  );

  for (const dependent of dependents) {
    const deps = dependent.frontmatter.dependsOn ?? [];
    const allDone = deps.every((depId) => {
      const depTask = allTasks.find((t) => t.frontmatter.id === depId);
      return depTask?.frontmatter.status === "done";
    });

    if (allDone) {
      await store.transition(dependent.frontmatter.id, "ready", {
        reason: "dependency_satisfied",
      });
      result.promoted.push(dependent.frontmatter.id);
    } else {
      result.skipped.push(dependent.frontmatter.id);
    }
  }

  if (result.promoted.length > 0 || result.skipped.length > 0) {
    await logger.log("dependency.cascaded", "system", {
      taskId: completedTaskId,
      payload: {
        trigger: completedTaskId,
        action: "promote",
        count: result.promoted.length,
        promoted: result.promoted,
        skipped: result.skipped,
      },
    });
  }

  return result;
}

/**
 * Called after a task transitions to "blocked" (opt-in, config-gated).
 *
 * Finds all direct dependents in backlog/ready state and blocks them with
 * an upstream-blocked reason.
 *
 * Emits one `dependency.cascaded` event summarising the operation.
 *
 * @remarks This is opt-in because cascade-blocking can be heavy-handed in
 * multi-parent dependency scenarios. Callers should gate on a config flag.
 */
export async function cascadeOnBlock(
  blockedTaskId: string,
  store: ITaskStore,
  logger: EventLogger,
): Promise<CascadeResult> {
  const result: CascadeResult = { promoted: [], blocked: [], skipped: [] };

  const allTasks = await store.list();

  const dependents = allTasks.filter(
    (t) =>
      (t.frontmatter.dependsOn ?? []).includes(blockedTaskId) &&
      (t.frontmatter.status === "backlog" || t.frontmatter.status === "ready"),
  );

  for (const dependent of dependents) {
    await store.block(
      dependent.frontmatter.id,
      `upstream blocked: ${blockedTaskId}`,
    );
    result.blocked.push(dependent.frontmatter.id);
  }

  if (result.blocked.length > 0) {
    await logger.log("dependency.cascaded", "system", {
      taskId: blockedTaskId,
      payload: {
        trigger: blockedTaskId,
        action: "block",
        count: result.blocked.length,
        blocked: result.blocked,
      },
    });
  }

  return result;
}
