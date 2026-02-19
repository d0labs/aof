/**
 * OpenClawExecutor — spawns agent sessions using OpenClaw's sessions API.
 * 
 * Primary dispatch: HTTP fetch to gateway REST API
 * Fallback: api.spawnAgent() if available
 */

import type { DispatchExecutor, TaskContext, ExecutorResult } from "../dispatch/executor.js";
import type { OpenClawApi, OpenClawExecutorOptions } from "./types.js";

export class OpenClawExecutor implements DispatchExecutor {
  private readonly gatewayUrl?: string;
  private readonly gatewayToken?: string;

  constructor(
    private readonly api: OpenClawApi,
    opts: OpenClawExecutorOptions = {}
  ) {
    // Priority: constructor opts > env vars > api.config
    this.gatewayUrl = opts.gatewayUrl 
      || process.env.OPENCLAW_GATEWAY_URL
      || this.deriveGatewayUrl();
    
    this.gatewayToken = opts.gatewayToken
      || process.env.OPENCLAW_GATEWAY_TOKEN
      || this.api.config?.gateway?.auth?.token;
  }

  async spawn(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
    console.info(`[AOF] OpenClawExecutor.spawn() for task ${context.taskId}, agent: ${context.agent}`);

    // Normalize agent ID - try multiple formats
    const agentIds = this.normalizeAgentId(context.agent);

    // Primary: HTTP dispatch to /tools/invoke (proven path, works with sessions_spawn allow-list)
    if (this.gatewayUrl && this.gatewayToken) {
      let lastPlatformLimit: number | undefined;
      let lastError: string | undefined;
      
      for (const agentId of agentIds) {
        try {
          console.info(`[AOF] No api.spawnAgent, falling back to HTTP dispatch with agentId: ${agentId}`);
          const contextWithAgent = { ...context, agent: agentId };
          const result = await this.httpDispatch(contextWithAgent, opts);
          return result;
        } catch (err: any) {
          const error = err as Error;
          console.warn(`[AOF] HTTP dispatch failed with agentId ${agentId}: ${error.message}`);
          
          // Preserve last error and platform limit
          lastError = error.message;
          if (err.platformLimit !== undefined) {
            lastPlatformLimit = err.platformLimit;
          }
        }
      }

      // HTTP failed, try api.spawnAgent() if available (future OpenClaw versions)
      if (this.api.spawnAgent) {
        console.info(`[AOF] HTTP dispatch failed, trying api.spawnAgent`);
        return this.spawnAgentFallbackWithNormalization(context, opts, agentIds);
      }

      return {
        success: false,
        error: lastError || `Dispatch failed for ${context.agent}: all spawn attempts exhausted`,
        platformLimit: lastPlatformLimit,
      };
    }

    // No HTTP config — try api.spawnAgent() directly
    if (this.api.spawnAgent) {
      return this.spawnAgentFallbackWithNormalization(context, opts, agentIds);
    }

    // No dispatch method available
    console.error(`[AOF] No dispatch method available (no gateway config, api.spawnAgent not present)`);
    return {
      success: false,
      error: "No dispatch method available — update OpenClaw or configure gateway",
    };
  }

  private normalizeAgentId(agent: string): string[] {
    // Return array of agent ID formats to try, in order
    const formats: string[] = [agent]; // Try raw value first
    
    // If not already in full format, try agent:xxx:main
    if (!agent.startsWith("agent:")) {
      formats.push(`agent:${agent}:main`);
    }
    
    return formats;
  }

  private async spawnAgentFallbackWithNormalization(
    context: TaskContext,
    opts: { timeoutMs?: number } | undefined,
    agentIds: string[]
  ): Promise<ExecutorResult> {
    let lastError: string | undefined;
    
    for (const agentId of agentIds) {
      const contextWithAgent = { ...context, agent: agentId };
      const result = await this.spawnAgentFallback(contextWithAgent, opts);
      
      if (result.success) {
        return result;
      }
      
      lastError = result.error;
      
      // If the error is not about agent not found, don't retry with other formats
      if (result.error && !result.error.toLowerCase().includes("agent") && !result.error.toLowerCase().includes("not found")) {
        console.warn(`[AOF] spawnAgent failed with non-agent error: ${result.error}`);
        return result; // Return immediately for non-agent errors
      }
      
      // Log failure but continue trying other formats for agent-related errors
      console.warn(`[AOF] spawnAgent failed with agentId ${agentId}: ${result.error}`);
    }
    
    // All formats failed with agent-related errors
    console.warn(`[AOF] Agent ${context.agent} not found in any format, leaving task in ready`);
    return {
      success: false,
      error: lastError || `Agent not found: ${context.agent}`,
    };
  }

  private async httpDispatch(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
    const taskInstruction = this.formatTaskInstruction(context);
    
    const payload = {
      tool: "sessions_spawn",
      args: {
        agentId: context.agent,
        task: taskInstruction,
        ...(context.thinking && { thinking: context.thinking }),
      },
      sessionKey: "agent:main:main",
    };

    const signal = AbortSignal.timeout(60000);
    
    try {
      const response = await fetch(`${this.gatewayUrl}/tools/invoke`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.gatewayToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      });

      // Always parse JSON to get detailed error messages
      const data = await response.json() as any;

      if (!response.ok) {
        // Try to extract error message from response body
        const errorMsg = data?.error || data?.message || `HTTP ${response.status} ${response.statusText}`;
        throw new Error(errorMsg);
      }

      // Check for application-level errors (HTTP 200 but tool returned error/forbidden)
      const details = data?.result?.details ?? data?.result ?? data;
      if (details?.status === "forbidden" || details?.status === "error") {
        const errorMsg = details.error || details.message || "Unknown spawn error";
        throw new Error(errorMsg);
      }

      const sessionId = this.extractSessionId(data);

      if (!sessionId) {
        throw new Error("No sessionId in response");
      }

      return {
        success: true,
        sessionId,
      };
    } catch (err) {
      const error = err as Error;
      const platformLimit = this.parsePlatformLimitError(error.message);
      
      // Throw error with platformLimit attached
      const enhancedError: any = new Error(error.message);
      enhancedError.platformLimit = platformLimit;
      throw enhancedError;
    }
  }

  private extractSessionId(data: any): string | undefined {
    // Try top-level sessionId
    if (data.sessionId) return data.sessionId;

    // Try result.sessionId
    if (data.result?.sessionId) return data.result.sessionId;

    // Try result.details child session identifiers
    if (data.result?.details?.childSessionKey) return data.result.details.childSessionKey;
    if (data.result?.details?.runId) return data.result.details.runId;

    // Try data.sessionId
    if (data.data?.sessionId) return data.data.sessionId;

    // Try result.content[0].text (nested JSON)
    if (data.result?.content?.[0]?.text) {
      try {
        const parsed = JSON.parse(data.result.content[0].text);
        if (parsed.childSessionKey) return parsed.childSessionKey;
        if (parsed.runId) return parsed.runId;
        if (parsed.sessionId) return parsed.sessionId;
      } catch {
        // Not JSON, ignore
      }
    }

    return undefined;
  }

  private async spawnAgentFallback(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
    if (!this.api.spawnAgent) {
      console.error(`[AOF] spawnAgent API not available — update OpenClaw or check plugin compatibility (task: ${context.taskId})`);
      
      return {
        success: false,
        error: "spawnAgent not available - update OpenClaw or check plugin compatibility (see gateway log for remediation steps)",
      };
    }



    try {
      const taskInstruction = this.formatTaskInstruction(context);

      const request = {
        agentId: context.agent,
        task: taskInstruction,
        context: {
          taskId: context.taskId,
          taskPath: context.taskPath,
          priority: context.priority,
          routing: context.routing,
          projectId: context.projectId,
          projectRoot: context.projectRoot,
          taskRelpath: context.taskRelpath,
        },
        timeoutMs: opts?.timeoutMs,
      };

      const response = await this.api.spawnAgent(request);

      if (response.success) {
        return {
          success: true,
          sessionId: response.sessionId,
        };
      } else {
        const platformLimit = response.error ? this.parsePlatformLimitError(response.error) : undefined;
        return {
          success: false,
          error: response.error ?? "Unknown spawn failure",
          platformLimit,
        };
      }
    } catch (err) {
      const error = err as Error;
      const errorMsg = error.message;
      const errorStack = error.stack ?? "No stack trace available";

      console.error(`[AOF] Spawn exception for ${context.taskId} (agent: ${context.agent}): ${errorMsg}`);

      const platformLimit = this.parsePlatformLimitError(errorMsg);
      return {
        success: false,
        error: errorMsg,
        platformLimit,
      };
    }
  }

  private formatTaskInstruction(context: TaskContext): string {
    let instruction = `Execute the task: ${context.taskId}

Task file: ${context.taskPath}`;

    if (context.projectId) {
      instruction += `\nProject: ${context.projectId}`;
    }
    if (context.projectRoot) {
      instruction += `\nProject root: ${context.projectRoot}`;
    }
    if (context.taskRelpath) {
      instruction += `\nTask path (relative): ${context.taskRelpath}`;
    }

    instruction += `\n\nPriority: ${context.priority}
Routing: ${JSON.stringify(context.routing)}

Read the task file for full details and acceptance criteria.

**IMPORTANT:** When you have completed this task, call the \`aof_task_complete\` tool with taskId="${context.taskId}" to mark it as done.`;

    return instruction;
  }

  private deriveGatewayUrl(): string | undefined {
    const port = this.api.config?.gateway?.port;
    if (port) {
      return `http://127.0.0.1:${port}`;
    }
    return undefined;
  }

  /**
   * Parse platform concurrency limit from OpenClaw error message.
   * 
   * Example error:
   *   "sessions_spawn has reached max active children for this session (3/2)"
   * 
   * Returns: 2 (the platform limit Y from pattern X/Y)
   */
  private parsePlatformLimitError(error: string): number | undefined {
    const match = error.match(/max active children for this session \((\d+)\/(\d+)\)/);
    if (match?.[2]) {
      return parseInt(match[2], 10); // Y = platform limit
    }
    return undefined;
  }
}
