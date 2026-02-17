/**
 * Tests for HTTP-based dispatch in OpenClawExecutor
 * TDD: Tests written before implementation
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenClawExecutor } from "../openclaw-executor.js";
import type { OpenClawApi } from "../types.js";
import type { TaskContext } from "../../dispatch/executor.js";

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe("OpenClawExecutor HTTP Dispatch", () => {
  let mockApi: OpenClawApi;
  let executor: OpenClawExecutor;
  let taskContext: TaskContext;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockApi = {
      config: {
        gateway: {
          port: 18789,
          auth: { token: "test-token-123" },
        },
      },
    } as OpenClawApi;

    taskContext = {
      taskId: "TASK-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: { team: "engineering" },
    };
  });

  it("HTTP success: fetch called with correct URL/headers/payload, returns parsed sessionId", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessionId: "session-test-001",
        sessionKey: "agent:swe-backend:test-001",
      }),
    });

    const result = await executor.spawn(taskContext);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/tools/invoke",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Authorization": "Bearer test-token-123",
          "Content-Type": "application/json",
        },
        body: expect.stringContaining('"tool":"sessions_spawn"'),
        signal: expect.any(AbortSignal),
      })
    );

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      tool: "sessions_spawn",
      args: {
        agentId: "swe-backend",
        task: expect.stringContaining("TASK-001"),
      },
      sessionKey: "agent:main:main",
    });

    expect(result).toEqual({
      success: true,
      sessionId: "session-test-001",
    });
  });

  it("uses thinking metadata when present in task context", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    const contextWithThinking: TaskContext = {
      ...taskContext,
      thinking: "medium",
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "session-002" }),
    });

    await executor.spawn(contextWithThinking);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.args.thinking).toBe("medium");
  });

  it("parses sessionId from result.content[0].text if present", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionId: "session-nested-001" }),
            },
          ],
        },
      }),
    });

    const result = await executor.spawn(taskContext);

    expect(result).toEqual({
      success: true,
      sessionId: "session-nested-001",
    });
  });

  it("parses childSessionKey from result.content[0].text if present", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ childSessionKey: "child-session-text-001" }),
            },
          ],
        },
      }),
    });

    const result = await executor.spawn(taskContext);

    expect(result).toEqual({
      success: true,
      sessionId: "child-session-text-001",
    });
  });

  it("parses childSessionKey from result.details if present", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          details: {
            childSessionKey: "child-session-details-001",
          },
        },
      }),
    });

    const result = await executor.spawn(taskContext);

    expect(result).toEqual({
      success: true,
      sessionId: "child-session-details-001",
    });
  });

  it("parses runId from result.details if present", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          details: {
            runId: "run-details-001",
          },
        },
      }),
    });

    const result = await executor.spawn(taskContext);

    expect(result).toEqual({
      success: true,
      sessionId: "run-details-001",
    });
  });

  it("parses sessionId from result field if present", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { sessionId: "session-result-001" },
      }),
    });

    const result = await executor.spawn(taskContext);

    expect(result).toEqual({
      success: true,
      sessionId: "session-result-001",
    });
  });

  it("parses sessionId from data field if present", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { sessionId: "session-data-001" },
      }),
    });

    const result = await executor.spawn(taskContext);

    expect(result).toEqual({
      success: true,
      sessionId: "session-data-001",
    });
  });

  it("fallback: fetch fails + spawnAgent exists uses spawnAgent", async () => {
    const apiWithSpawn = {
      ...mockApi,
      spawnAgent: vi.fn(async () => ({
        success: true,
        sessionId: "session-fallback-001",
      })),
    };

    executor = new OpenClawExecutor(apiWithSpawn, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    // Fetch fails for both agent ID formats
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await executor.spawn(taskContext);

    // HTTP tried first (2 agent ID formats), then falls back to spawnAgent
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(apiWithSpawn.spawnAgent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      sessionId: "session-fallback-001",
    });
  });

  it("no dispatch: no config + no spawnAgent returns failure result", async () => {
    const apiNoConfig = {} as OpenClawApi;
    executor = new OpenClawExecutor(apiNoConfig);

    const result = await executor.spawn(taskContext);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain("No dispatch method");
  });

  it("resolves config from env vars when not in constructor opts", async () => {
    process.env.OPENCLAW_GATEWAY_URL = "http://127.0.0.1:19000";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-456";

    executor = new OpenClawExecutor(mockApi);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "session-env-001" }),
    });

    await executor.spawn(taskContext);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:19000/tools/invoke",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Authorization": "Bearer env-token-456",
        }),
      })
    );

    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  it("resolves config from api.config.gateway when no opts or env", async () => {
    executor = new OpenClawExecutor(mockApi);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "session-api-config-001" }),
    });

    await executor.spawn(taskContext);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/tools/invoke",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Authorization": "Bearer test-token-123",
        }),
      })
    );
  });

  it("prioritizes constructor opts over env vars", async () => {
    process.env.OPENCLAW_GATEWAY_URL = "http://127.0.0.1:19000";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-456";

    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:20000",
      gatewayToken: "opts-token-789",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "session-opts-001" }),
    });

    await executor.spawn(taskContext);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:20000/tools/invoke",
      expect.any(Object)
    );

    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  it("uses 60s timeout via AbortSignal", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "session-timeout-001" }),
    });

    await executor.spawn(taskContext);

    const signal = mockFetch.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("handles HTTP error responses gracefully", async () => {
    executor = new OpenClawExecutor(mockApi, {
      gatewayUrl: "http://127.0.0.1:18789",
      gatewayToken: "test-token-123",
    });

    // HTTP error for both agent ID formats
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const result = await executor.spawn(taskContext);

    expect(result.success).toBe(false);
    // After HTTP fails for all formats, it tries spawnAgent and that also fails
    // So the final error is about agent not found
    expect(result.error).toBeDefined();
  });
});
