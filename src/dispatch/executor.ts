/**
 * Dispatch executor interface — spawns agent sessions for assigned tasks.
 *
 * Core library defines the interface; adapters provide implementations.
 * This keeps the core portable across different execution engines.
 */

import type { TaskThinking } from "../schemas/task.js";
import type { GateContext } from "./gate-context-builder.js";

export interface TaskContext {
  taskId: string;
  taskPath: string;
  /** Pre-read task file contents (BUG-002 fix: read before state transition) */
  taskFileContents?: string;
  agent: string;
  priority: string;
  thinking?: TaskThinking;
  routing: {
    role?: string;
    team?: string;
    tags?: string[];
  };
  /** Project ID (from project manifest or directory name) */
  projectId?: string;
  /** Absolute path to project root */
  projectRoot?: string;
  /** Task path relative to project root */
  taskRelpath?: string;
  /** Gate context (transient, computed on dispatch) — Progressive Disclosure Level 2 */
  gateContext?: GateContext;
}

export interface ExecutorResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  platformLimit?: number;  // OpenClaw platform concurrency limit (from error message)
}

export interface DispatchExecutor {
  /**
   * Spawn an agent session for a task.
   *
   * @param context - Task context (id, path, agent, routing)
   * @param opts - Execution options (timeout, etc.)
   * @returns Result with session ID or error
   */
  spawn(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult>;
}

/**
 * Mock executor for testing.
 */
export class MockExecutor implements DispatchExecutor {
  readonly spawned: Array<{ context: TaskContext; opts?: { timeoutMs?: number } }> = [];
  private shouldFail = false;
  private shouldThrow = false;
  private failureError = "Mock spawn failure";

  async spawn(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
    this.spawned.push({ context, opts });

    if (this.shouldThrow) {
      throw new Error(this.failureError);
    }

    if (this.shouldFail) {
      return { success: false, error: this.failureError };
    }

    return {
      success: true,
      sessionId: `mock-session-${context.taskId}`,
    };
  }

  setShouldFail(fail: boolean, error?: string): void {
    this.shouldFail = fail;
    if (error) this.failureError = error;
  }

  setShouldThrow(shouldThrow: boolean, error?: string): void {
    this.shouldThrow = shouldThrow;
    if (error) {
      this.failureError = error;
    } else if (shouldThrow) {
      this.failureError = "Mock executor exception";
    }
  }

  clear(): void {
    this.spawned.length = 0;
  }
}
