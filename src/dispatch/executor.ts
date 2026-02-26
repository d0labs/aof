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

/**
 * Result of spawning an agent session.
 */
export interface SpawnResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  platformLimit?: number;  // OpenClaw platform concurrency limit (from error message)
}

/** @deprecated Use SpawnResult instead. */
export type ExecutorResult = SpawnResult;

/**
 * Status of an active or completed agent session.
 */
export interface SessionStatus {
  sessionId: string;
  alive: boolean;
  lastHeartbeatAt?: string;
  completedAt?: string;
}

/**
 * GatewayAdapter — full lifecycle adapter for agent session management.
 *
 * Replaces the single-method DispatchExecutor with a three-method contract
 * supporting session tracking and force-completion.
 */
export interface GatewayAdapter {
  /**
   * Spawn an agent session for a task.
   *
   * @param context - Task context (id, path, agent, routing)
   * @param opts - Execution options (timeout, correlation ID)
   * @returns Result with session ID or error
   */
  spawnSession(
    context: TaskContext,
    opts?: { timeoutMs?: number; correlationId?: string },
  ): Promise<SpawnResult>;

  /**
   * Poll session status (heartbeat liveness check).
   *
   * @param sessionId - Session identifier returned by spawnSession
   * @returns Current session status
   */
  getSessionStatus(sessionId: string): Promise<SessionStatus>;

  /**
   * Force-complete a stuck session.
   *
   * @param sessionId - Session identifier to force-complete
   */
  forceCompleteSession(sessionId: string): Promise<void>;
}

/** @deprecated Use GatewayAdapter instead. */
export type DispatchExecutor = GatewayAdapter;

// ---------------------------------------------------------------------------
// Mock session tracking types (internal to MockAdapter)
// ---------------------------------------------------------------------------

interface MockSession {
  sessionId: string;
  taskId: string;
  correlationId?: string;
  startedAt: number;
  lastHeartbeat: number;
  completed: boolean;
  completedAt?: string;
  stale: boolean;
}

interface MockAdapterOptions {
  /** Delay in ms before auto-completing a session (default: 0 = instant). */
  completionDelayMs?: number;
  /** Whether sessions auto-complete after completionDelayMs (default: true). */
  autoComplete?: boolean;
}

/**
 * Mock adapter for testing — implements GatewayAdapter with configurable
 * completion delays and failure simulation.
 */
export class MockAdapter implements GatewayAdapter {
  readonly spawned: Array<{
    context: TaskContext;
    opts?: { timeoutMs?: number; correlationId?: string };
  }> = [];

  private sessions = new Map<string, MockSession>();
  private shouldFail = false;
  private shouldThrow = false;
  private failureError = "Mock spawn failure";
  private autoCompleteEnabled: boolean;
  private completionDelayMs: number;

  constructor(opts: MockAdapterOptions = {}) {
    this.completionDelayMs = opts.completionDelayMs ?? 0;
    this.autoCompleteEnabled = opts.autoComplete ?? true;
  }

  async spawnSession(
    context: TaskContext,
    opts?: { timeoutMs?: number; correlationId?: string },
  ): Promise<SpawnResult> {
    this.spawned.push({ context, opts });

    if (this.shouldThrow) {
      throw new Error(this.failureError);
    }

    if (this.shouldFail) {
      return { success: false, error: this.failureError };
    }

    const sessionId = `mock-session-${context.taskId}`;
    const now = Date.now();

    this.sessions.set(sessionId, {
      sessionId,
      taskId: context.taskId,
      correlationId: opts?.correlationId,
      startedAt: now,
      lastHeartbeat: now,
      completed: false,
      stale: false,
    });

    // Schedule auto-completion after delay
    if (this.autoCompleteEnabled) {
      if (this.completionDelayMs === 0) {
        // Instant auto-complete (microtask)
        void Promise.resolve().then(() => this.completeSession(sessionId));
      } else {
        setTimeout(() => this.completeSession(sessionId), this.completionDelayMs);
      }
    }

    return { success: true, sessionId };
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { sessionId, alive: false };
    }

    if (session.stale) {
      return {
        sessionId,
        alive: false,
        lastHeartbeatAt: new Date(session.lastHeartbeat).toISOString(),
      };
    }

    return {
      sessionId,
      alive: !session.completed,
      lastHeartbeatAt: new Date(session.lastHeartbeat).toISOString(),
      completedAt: session.completedAt,
    };
  }

  async forceCompleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.completed = true;
      session.completedAt = new Date().toISOString();
    }
  }

  // ---- Test helpers ----

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

  /** Mark a session as stale (simulates heartbeat timeout). */
  setSessionStale(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.stale = true;
    }
  }

  /** Toggle auto-completion behavior. */
  setAutoComplete(enabled: boolean): void {
    this.autoCompleteEnabled = enabled;
  }

  clear(): void {
    this.spawned.length = 0;
    this.sessions.clear();
  }

  /** Complete a session (used internally and for testing). */
  private completeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && !session.completed) {
      session.completed = true;
      session.completedAt = new Date().toISOString();
    }
  }
}

/** @deprecated Use MockAdapter instead. */
export const MockExecutor = MockAdapter;
