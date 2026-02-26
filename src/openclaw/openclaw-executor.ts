/**
 * OpenClawAdapter — spawns agent sessions via in-process runEmbeddedPiAgent().
 *
 * Runs agents directly inside the gateway process, bypassing HTTP dispatch,
 * WebSocket auth, and device pairing entirely. This is the same code path
 * the gateway itself uses for all agent execution.
 *
 * The extensionAPI module is loaded lazily on first spawn from the gateway's
 * dist directory.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GatewayAdapter, TaskContext, SpawnResult, SessionStatus } from "../dispatch/executor.js";
import type { OpenClawApi } from "./types.js";
import type { ITaskStore } from "../store/interfaces.js";
import { readHeartbeat, markRunArtifactExpired } from "../recovery/run-artifacts.js";

/** Minimal shape of the functions we need from extensionAPI.js */
interface ExtensionApi {
  runEmbeddedPiAgent: (params: Record<string, unknown>) => Promise<EmbeddedPiRunResult>;
  resolveAgentWorkspaceDir: (cfg: Record<string, unknown>, agentId: string) => string;
  resolveAgentDir: (cfg: Record<string, unknown>, agentId: string) => string;
  ensureAgentWorkspace: (params: { dir: string }) => Promise<{ dir: string }>;
  resolveSessionFilePath: (sessionId: string) => string;
}

/** Subset of the result type we actually use */
interface EmbeddedPiRunResult {
  payloads?: Array<{
    text?: string;
    isError?: boolean;
  }>;
  meta: {
    durationMs: number;
    agentMeta?: {
      sessionId: string;
      provider: string;
      model: string;
    };
    aborted?: boolean;
    error?: {
      kind: string;
      message: string;
    };
  };
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export class OpenClawAdapter implements GatewayAdapter {
  private extensionApi: ExtensionApi | undefined;
  private extensionApiLoadPromise: Promise<ExtensionApi> | undefined;
  private sessionToTask = new Map<string, string>();

  constructor(
    private readonly api: OpenClawApi,
    private readonly store?: ITaskStore,
  ) {
    console.info("[AOF] OpenClawAdapter initialized (embedded agent mode)");
  }

  async spawnSession(
    context: TaskContext,
    opts?: { timeoutMs?: number; correlationId?: string },
  ): Promise<SpawnResult> {
    console.info(`[AOF] OpenClawAdapter.spawnSession() for task ${context.taskId}, agent: ${context.agent}`);

    let ext: ExtensionApi;
    try {
      ext = await this.loadExtensionApi();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[AOF] Failed to load extensionAPI: ${message}`);
      return {
        success: false,
        error: `Failed to load gateway extensionAPI: ${message}`,
      };
    }

    const config = this.api.config as Record<string, unknown> | undefined;
    if (!config) {
      return {
        success: false,
        error: "No OpenClaw config available on api.config",
      };
    }

    const agentId = this.normalizeAgentId(context.agent);
    const sessionId = randomUUID();
    const runId = sessionId;
    // The scheduler's spawnTimeoutMs (default 30s) was designed for fast HTTP
    // dispatch. For embedded agents, we need the full execution budget.
    // Use the larger of the caller's timeout and our minimum.
    const timeoutMs = Math.max(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

    try {
      // Resolve paths synchronously so failures are reported to the scheduler
      const workspaceDirRaw = ext.resolveAgentWorkspaceDir(config, agentId);
      const { dir: workspaceDir } = await ext.ensureAgentWorkspace({ dir: workspaceDirRaw });
      const agentDir = ext.resolveAgentDir(config, agentId);
      const sessionFile = ext.resolveSessionFilePath(sessionId);

      const prompt = this.formatTaskInstruction(context);

      console.info(`[AOF] Launching embedded agent (fire-and-forget): agentId=${agentId}, sessionId=${sessionId}`);

      // Fire-and-forget: launch the agent in the background so the scheduler
      // isn't blocked by the spawnTimeoutMs (designed for fast HTTP dispatch).
      // The agent calls aof_task_complete when done; the scheduler's lease
      // expiry handles the failure case.
      void this.runAgentBackground(ext, {
        sessionId,
        sessionFile,
        workspaceDir,
        agentDir,
        config,
        prompt,
        agentId,
        timeoutMs,
        runId,
        taskId: context.taskId,
        thinking: context.thinking,
      });

      // Track sessionId -> taskId mapping for getSessionStatus / forceCompleteSession
      this.sessionToTask.set(sessionId, context.taskId);

      return {
        success: true,
        sessionId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[AOF] Embedded agent setup failed: ${message}`);

      const platformLimit = this.parsePlatformLimitError(message);

      return {
        success: false,
        error: message,
        platformLimit,
      };
    }
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) {
      return { sessionId, alive: false };
    }

    if (!this.store) {
      // No store available — cannot check heartbeat
      return { sessionId, alive: false };
    }

    const heartbeat = await readHeartbeat(this.store, taskId);
    if (!heartbeat) {
      return { sessionId, alive: false };
    }

    const expiresAt = heartbeat.expiresAt
      ? new Date(heartbeat.expiresAt).getTime()
      : 0;

    return {
      sessionId,
      alive: expiresAt > Date.now(),
      lastHeartbeatAt: heartbeat.lastHeartbeat,
    };
  }

  async forceCompleteSession(sessionId: string): Promise<void> {
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) {
      return;
    }

    if (this.store) {
      await markRunArtifactExpired(this.store, taskId, "force_completed");
    }

    this.sessionToTask.delete(sessionId);
    console.info(`[AOF] Force-completed session ${sessionId} (task ${taskId})`);
  }

  /** Run the embedded agent in the background, logging results when done. */
  private async runAgentBackground(
    ext: ExtensionApi,
    params: {
      sessionId: string;
      sessionFile: string;
      workspaceDir: string;
      agentDir: string;
      config: Record<string, unknown>;
      prompt: string;
      agentId: string;
      timeoutMs: number;
      runId: string;
      taskId: string;
      thinking?: string;
    },
  ): Promise<void> {
    try {
      const result = await ext.runEmbeddedPiAgent({
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: params.config,
        prompt: params.prompt,
        agentId: params.agentId,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        lane: "aof",
        senderIsOwner: true,
        ...(params.thinking && { thinkLevel: params.thinking }),
      });

      if (result.meta.error) {
        console.warn(
          `[AOF] Agent run completed with error for ${params.taskId}: ${result.meta.error.kind}: ${result.meta.error.message}`,
        );
      } else if (result.meta.aborted) {
        console.warn(`[AOF] Agent run was aborted for ${params.taskId}`);
      } else {
        console.info(
          `[AOF] Agent run completed for ${params.taskId} in ${result.meta.durationMs}ms`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[AOF] Background agent run failed for ${params.taskId}: ${message}`);
    }
  }

  private normalizeAgentId(agent: string): string {
    // Strip "agent:" prefix if present (e.g. "agent:swe-backend:main" -> "swe-backend")
    if (agent.startsWith("agent:")) {
      const parts = agent.split(":");
      return parts[1] ?? agent;
    }
    return agent;
  }

  private formatTaskInstruction(context: TaskContext): string {
    let instruction = `Execute the task: ${context.taskId}\n\nTask file: ${context.taskPath}`;

    if (context.projectId) {
      instruction += `\nProject: ${context.projectId}`;
    }
    if (context.projectRoot) {
      instruction += `\nProject root: ${context.projectRoot}`;
    }
    if (context.taskRelpath) {
      instruction += `\nTask path (relative): ${context.taskRelpath}`;
    }

    instruction += `\n\nPriority: ${context.priority}\nRouting: ${JSON.stringify(context.routing)}\n\nRead the task file for full details and acceptance criteria.\n\n**IMPORTANT:** When you have completed this task, call the \`aof_task_complete\` tool with taskId="${context.taskId}" to mark it as done.`;

    return instruction;
  }

  /**
   * Lazily load the gateway's extensionAPI module.
   * Cached after first successful load.
   */
  private async loadExtensionApi(): Promise<ExtensionApi> {
    if (this.extensionApi) return this.extensionApi;

    // Deduplicate concurrent loads
    if (this.extensionApiLoadPromise) return this.extensionApiLoadPromise;

    this.extensionApiLoadPromise = this.doLoadExtensionApi();
    try {
      this.extensionApi = await this.extensionApiLoadPromise;
      return this.extensionApi;
    } finally {
      this.extensionApiLoadPromise = undefined;
    }
  }

  private async doLoadExtensionApi(): Promise<ExtensionApi> {
    const distDir = this.resolveGatewayDistDir();
    const extensionApiPath = join(distDir, "extensionAPI.js");
    const url = new URL(`file://${extensionApiPath}`).href;

    // The bundled extensionAPI and its dependency graph resolve config/paths
    // relative to CWD. The gateway process CWD is typically "/", which causes
    // module initialization failures. Temporarily switch to the workspace
    // package root so relative lookups succeed.
    const packageDir = join(distDir, "..");
    const prevCwd = process.cwd();
    process.chdir(packageDir);

    let mod: Record<string, unknown>;
    try {
      mod = await import(url);
    } finally {
      process.chdir(prevCwd);
    }

    // Validate required exports
    const required = [
      "runEmbeddedPiAgent",
      "resolveAgentWorkspaceDir",
      "resolveAgentDir",
      "ensureAgentWorkspace",
      "resolveSessionFilePath",
    ] as const;

    for (const name of required) {
      if (typeof mod[name] !== "function") {
        throw new Error(`extensionAPI.js missing export: ${name}`);
      }
    }

    console.info(`[AOF] Loaded extensionAPI from ${extensionApiPath}`);
    return mod as unknown as ExtensionApi;
  }

  /**
   * Resolve the gateway dist directory.
   * Order: OPENCLAW_STATE_DIR env > ~/.openclaw
   */
  private resolveGatewayDistDir(): string {
    const stateDir =
      process.env.OPENCLAW_STATE_DIR?.trim() ||
      process.env.CLAWDBOT_STATE_DIR?.trim() ||
      join(homedir(), ".openclaw");
    return join(stateDir, "workspace", "package", "dist");
  }

  private parsePlatformLimitError(error: string): number | undefined {
    const match = error.match(/max active children for this session \((\d+)\/(\d+)\)/);
    if (match?.[2]) {
      return parseInt(match[2], 10);
    }
    return undefined;
  }
}

/** @deprecated Use OpenClawAdapter instead. */
export const OpenClawExecutor = OpenClawAdapter;
