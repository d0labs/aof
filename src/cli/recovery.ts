/**
 * CLI recovery logic — check and repair system state on command failure.
 * 
 * Recovery hooks check for:
 * - Expired leases (TTL exceeded)
 * - Stale heartbeats (>10min since last heartbeat)
 * 
 * Recovery does NOT retry the original operation - it only repairs state
 * and provides actionable feedback to the user.
 * 
 * See AOF-l7y task brief for requirements.
 */

import type { TaskStore } from "../store/task-store.js";
import type { EventLogger } from "../events/logger.js";

export interface RecoveryAction {
  type: string;
  details: Record<string, unknown>;
}

export interface RecoveryResult {
  recovered: boolean;
  actions: RecoveryAction[];
  error?: string;
}

const LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Attempt to recover from a command failure by checking system state.
 * 
 * Recovery checks:
 * 1. Lease expiry (TTL exceeded)
 * 2. Heartbeat staleness (future enhancement)
 * 
 * If issues are found, recovery attempts to repair them and logs actions.
 * Recovery does NOT retry the original operation.
 * 
 * @param store - Task store
 * @param eventLogger - Event logger
 * @param taskId - Task ID that failed
 * @returns Recovery result with actions taken
 */
export async function attemptRecovery(
  store: TaskStore,
  eventLogger: EventLogger,
  taskId: string
): Promise<RecoveryResult> {
  const actions: RecoveryAction[] = [];

  // Get task
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Check 1: Lease expiry
  if (task.frontmatter.lease) {
    const expiresAt = new Date(task.frontmatter.lease.expiresAt).getTime();
    const now = Date.now();
    
    if (now > expiresAt) {
      // Lease expired - reclaim task to ready
      await store.transition(taskId, "ready", {
        reason: "lease_expired_recovery",
        agent: "system",
      });
      
      actions.push({
        type: "lease_expired",
        details: {
          leaseExpiredAt: task.frontmatter.lease.expiresAt,
          transitionedTo: "ready",
        },
      });
    }
  }

  // Check 2: Heartbeat staleness (future enhancement)
  // For Phase 1.5, we only check lease expiry

  // Log all recovery actions
  for (const action of actions) {
    await eventLogger.log("recovery_action", "system", {
      taskId,
      payload: {
        action: action.type,
        details: action.details,
      },
    });
  }

  return {
    recovered: actions.length > 0,
    actions,
  };
}

/**
 * Format recovery result as user-facing summary.
 * 
 * @param result - Recovery result
 * @returns Formatted summary string
 */
export function formatRecoverySummary(result: RecoveryResult): string {
  if (!result.recovered) {
    return "❌ Recovery could not resolve the issue. Manual intervention required.";
  }

  const lines = ["🔧 Recovery triggered:"];
  
  for (const action of result.actions) {
    if (action.type === "lease_expired") {
      lines.push("   - Lease expired (10min TTL exceeded)");
      lines.push("   - Task reclaimed to ready");
    }
    // Future: heartbeat_stale handling
  }
  
  lines.push("✅ Recovery complete. Retry your command.");
  
  return lines.join("\n");
}
