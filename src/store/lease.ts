/**
 * Lease management — filesystem-based locking for task assignment.
 *
 * Leases are stored inside the task frontmatter (not as separate lockfiles).
 * This keeps the SSOT principle — task file = complete state.
 *
 * Lease operations:
 * - acquire: assign task to agent with TTL
 * - renew: extend lease TTL (up to maxRenewals)
 * - release: voluntarily give up lease
 * - expire: reclaim tasks with expired leases (called by dispatcher)
 */

import type { TaskLease } from "../schemas/task.js";
import { FilesystemTaskStore, serializeTask } from "./task-store.js";
import type { ITaskStore } from "./interfaces.js";
import { writeRunArtifact, writeHeartbeat } from "../recovery/run-artifacts.js";
import writeFileAtomic from "write-file-atomic";

export interface LeaseOptions {
  /** Lease TTL in milliseconds. */
  ttlMs: number;
  /** Maximum number of renewals. */
  maxRenewals: number;
  /** Heartbeat TTL in milliseconds (default 5min). */
  heartbeatTtlMs?: number;
  /** Write run artifacts on acquire (default true). */
  writeRunArtifacts?: boolean;
}

const DEFAULT_LEASE_OPTIONS: LeaseOptions = {
  ttlMs: 600_000, // 10 minutes
  maxRenewals: 3,
  heartbeatTtlMs: 300_000, // 5 minutes
  writeRunArtifacts: true,
};

/** Write a task back atomically to its current location. */
async function writeBack(store: ITaskStore, task: { frontmatter: { id: string; status: string }; path?: string }, serialized: string): Promise<void> {
  const filePath = task.path!;
  await writeFileAtomic(filePath, serialized);
}

/** Acquire a lease on a task for an agent. */
export async function acquireLease(
  store: ITaskStore,
  taskId: string,
  agentId: string,
  opts: Partial<LeaseOptions> = {},
): Promise<ReturnType<ITaskStore["get"]>> {
  const { ttlMs } = { ...DEFAULT_LEASE_OPTIONS, ...opts };

  const task = await store.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (task.frontmatter.status !== "ready" && task.frontmatter.status !== "in-progress") {
    throw new Error(
      `Cannot acquire lease: task ${taskId} is ${task.frontmatter.status} (must be ready or in-progress)`,
    );
  }

  // Check for existing unexpired lease by another agent
  if (task.frontmatter.lease) {
    const existing = task.frontmatter.lease;
    const expiresAt = new Date(existing.expiresAt).getTime();

    if (expiresAt > Date.now() && existing.agent !== agentId) {
      throw new Error(
        `Task ${taskId} is leased to ${existing.agent} until ${existing.expiresAt}`,
      );
    }
  }

  const now = new Date();
  const lease: TaskLease = {
    agent: agentId,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    renewCount: 0,
  };

  task.frontmatter.lease = lease;
  task.frontmatter.updatedAt = now.toISOString();

  // Write lease to current file first (so transition preserves it)
  await writeBack(store, task, serializeTask(task));

  // Transition to "in-progress" status (moves file to in-progress/ directory)
  let result = task;
  if (task.frontmatter.status === "ready") {
    result = await store.transition(taskId, "in-progress", { agent: agentId });
  }

  // Write run artifacts (P2.3 resume protocol)
  const writeArtifacts = opts.writeRunArtifacts ?? DEFAULT_LEASE_OPTIONS.writeRunArtifacts;
  if (writeArtifacts) {
    const heartbeatTtl = opts.heartbeatTtlMs ?? DEFAULT_LEASE_OPTIONS.heartbeatTtlMs!;
    await writeRunArtifact(store, taskId, agentId);
    await writeHeartbeat(store, taskId, agentId, heartbeatTtl);
  }

  return result;
}

/** Renew an existing lease. */
export async function renewLease(
  store: ITaskStore,
  taskId: string,
  agentId: string,
  opts: Partial<LeaseOptions> = {},
): Promise<ReturnType<ITaskStore["get"]>> {
  const { ttlMs, maxRenewals } = { ...DEFAULT_LEASE_OPTIONS, ...opts };

  const task = await store.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const lease = task.frontmatter.lease;
  if (!lease) throw new Error(`Task ${taskId} has no active lease`);
  if (lease.agent !== agentId) {
    throw new Error(`Task ${taskId} is leased to ${lease.agent}, not ${agentId}`);
  }
  if (lease.renewCount >= maxRenewals) {
    throw new Error(
      `Task ${taskId} has exhausted lease renewals (${maxRenewals} max)`,
    );
  }

  const now = new Date();
  lease.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  lease.renewCount += 1;
  task.frontmatter.updatedAt = now.toISOString();

  await writeBack(store, task, serializeTask(task));
  return task;
}

/** Release a lease voluntarily. Task goes back to pending. */
export async function releaseLease(
  store: ITaskStore,
  taskId: string,
  agentId: string,
): Promise<ReturnType<ITaskStore["get"]>> {
  const task = await store.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const lease = task.frontmatter.lease;
  if (!lease) throw new Error(`Task ${taskId} has no active lease`);
  if (lease.agent !== agentId) {
    throw new Error(`Task ${taskId} is leased to ${lease.agent}, not ${agentId}`);
  }

  task.frontmatter.lease = undefined;

  // Transition back to ready (moves file back to ready/ directory)
  return store.transition(taskId, "ready");
}

/** Find and expire all tasks with expired leases. Returns expired task IDs. */
export async function expireLeases(store: ITaskStore): Promise<string[]> {
  // BUG-AUDIT-001: Scan both in-progress AND blocked tasks for expired leases
  const inProgress = await store.list({ status: "in-progress" });
  const blocked = await store.list({ status: "blocked" });
  const tasksToCheck = [...inProgress, ...blocked];
  
  const expired: string[] = [];

  for (const task of tasksToCheck) {
    const lease = task.frontmatter.lease;
    if (!lease) continue;

    const expiresAt = new Date(lease.expiresAt).getTime();
    if (expiresAt <= Date.now()) {
      // Clear the lease
      task.frontmatter.lease = undefined;
      
      // BUG-AUDIT-002: For blocked tasks, check if they can transition to ready
      if (task.frontmatter.status === "blocked") {
        // Check if dependencies are satisfied
        const deps = task.frontmatter.dependsOn ?? [];
        const allDepsResolved = deps.length === 0 || await checkDependenciesSatisfied(store, deps);
        
        if (allDepsResolved) {
          // Dependencies satisfied - transition to ready
          await store.transition(task.frontmatter.id, "ready", { 
            reason: "lease_expired_requeue" 
          });
        } else {
          // Dependencies not satisfied - just clear the lease, stay blocked
          await writeBack(store, task, serializeTask(task));
        }
      } else {
        // In-progress task - transition back to ready
        await store.transition(task.frontmatter.id, "ready", { 
          reason: "lease_expired" 
        });
      }
      
      expired.push(task.frontmatter.id);
    }
  }

  return expired;
}

/** Check if all dependencies are satisfied (done). */
async function checkDependenciesSatisfied(store: ITaskStore, depIds: string[]): Promise<boolean> {
  for (const depId of depIds) {
    const dep = await store.get(depId);
    if (!dep || dep.frontmatter.status !== "done") {
      return false;
    }
  }
  return true;
}
