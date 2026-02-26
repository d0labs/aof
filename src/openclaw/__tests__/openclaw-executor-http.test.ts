/**
 * Tests for embedded agent dispatch in OpenClawAdapter
 *
 * The executor uses fire-and-forget: spawn() returns immediately with
 * { success: true, sessionId } after launching the agent in the background.
 * Only setup failures (missing config, extensionAPI load errors) return
 * { success: false }.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenClawAdapter } from "../openclaw-executor.js";
import type { OpenClawApi } from "../types.js";
import type { TaskContext } from "../../dispatch/executor.js";

// Mock the dynamic import of extensionAPI
const mockRunEmbeddedPiAgent = vi.fn();
const mockResolveAgentWorkspaceDir = vi.fn(() => "/tmp/workspace/swe-backend");
const mockResolveAgentDir = vi.fn(() => "/tmp/agents/swe-backend");
const mockEnsureAgentWorkspace = vi.fn(async (p: { dir: string }) => ({ dir: p.dir }));
const mockResolveSessionFilePath = vi.fn((id: string) => `/tmp/sessions/${id}.jsonl`);

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => "test-uuid-1234",
  };
});

describe("OpenClawAdapter (embedded agent)", () => {
  let mockApi: OpenClawApi;
  let executor: OpenClawAdapter;
  let taskContext: TaskContext;

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      config: {
        agents: { list: [] },
      },
    } as unknown as OpenClawApi;

    taskContext = {
      taskId: "TASK-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: { team: "engineering" },
    };

    executor = new OpenClawAdapter(mockApi);

    // Inject the mock extensionAPI (bypass lazy loading)
    (executor as any).extensionApi = {
      runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
      resolveAgentWorkspaceDir: mockResolveAgentWorkspaceDir,
      resolveAgentDir: mockResolveAgentDir,
      ensureAgentWorkspace: mockEnsureAgentWorkspace,
      resolveSessionFilePath: mockResolveSessionFilePath,
    };
  });

  it("calls runEmbeddedPiAgent with correct params and returns generated sessionId", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "Task completed" }],
      meta: {
        durationMs: 5000,
        agentMeta: { sessionId: "embedded-session-001", provider: "anthropic", model: "claude-sonnet-4-20250514" },
      },
    });

    const result = await executor.spawnSession(taskContext);

    // Fire-and-forget: returns immediately with the generated sessionId
    expect(result).toEqual({
      success: true,
      sessionId: "test-uuid-1234",
    });

    // Wait for the background promise to resolve
    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));

    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params).toMatchObject({
      sessionId: "test-uuid-1234",
      runId: "test-uuid-1234",
      agentId: "swe-backend",
      prompt: expect.stringContaining("TASK-001"),
      lane: "aof",
      senderIsOwner: true,
    });
    expect(params.sessionFile).toContain("test-uuid-1234");
    expect(params.workspaceDir).toBe("/tmp/workspace/swe-backend");
    expect(params.agentDir).toBe("/tmp/agents/swe-backend");
    expect(params.timeoutMs).toBe(300_000);
  });

  it("passes thinking level from task context", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s1", provider: "a", model: "m" } },
    });

    await executor.spawnSession({ ...taskContext, thinking: "medium" });
    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));

    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.thinkLevel).toBe("medium");
  });

  it("logs agent run errors in background without affecting spawn result", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: {
        durationMs: 2000,
        error: { kind: "context_overflow", message: "Token limit exceeded" },
        agentMeta: { sessionId: "s-err", provider: "a", model: "m" },
      },
    });

    const result = await executor.spawnSession(taskContext);

    // Spawn returns success (fire-and-forget)
    expect(result.success).toBe(true);

    // Background logs the error
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("context_overflow"),
    ));

    warnSpy.mockRestore();
  });

  it("logs aborted agent run in background without affecting spawn result", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, aborted: true },
    });

    const result = await executor.spawnSession(taskContext);

    expect(result.success).toBe(true);

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("aborted"),
    ));

    warnSpy.mockRestore();
  });

  it("logs thrown exception in background without affecting spawn result", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("Runtime crash"));

    const result = await executor.spawnSession(taskContext);

    expect(result.success).toBe(true);

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Runtime crash"),
    ));

    errorSpy.mockRestore();
  });

  it("returns error when api.config is missing", async () => {
    const noConfigApi = {} as unknown as OpenClawApi;
    const exec = new OpenClawAdapter(noConfigApi);
    (exec as any).extensionApi = (executor as any).extensionApi;

    const result = await exec.spawnSession(taskContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain("No OpenClaw config");
  });

  it("normalizes agent:prefix:suffix to just the agent name", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s2", provider: "a", model: "m" } },
    });

    await executor.spawnSession({ ...taskContext, agent: "agent:swe-backend:main" });
    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));

    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.agentId).toBe("swe-backend");
  });

  it("includes project context in prompt when available", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s3", provider: "a", model: "m" } },
    });

    await executor.spawnSession({
      ...taskContext,
      projectId: "my-project",
      projectRoot: "/home/user/my-project",
      taskRelpath: "tasks/TASK-001.md",
    });
    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));

    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("my-project");
    expect(params.prompt).toContain("/home/user/my-project");
    expect(params.prompt).toContain("tasks/TASK-001.md");
  });

  it("uses custom timeout from opts", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s4", provider: "a", model: "m" } },
    });

    await executor.spawnSession(taskContext, { timeoutMs: 60_000 });
    await vi.waitFor(() => expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1));

    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.timeoutMs).toBe(60_000);
  });

  it("returns generated sessionId (not agentMeta sessionId) since dispatch is fire-and-forget", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000 },
    });

    const result = await executor.spawnSession(taskContext);

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("test-uuid-1234");
  });

  it("returns setup failure when ensureAgentWorkspace throws", async () => {
    mockEnsureAgentWorkspace.mockRejectedValueOnce(new Error("Disk full"));

    const result = await executor.spawnSession(taskContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Disk full");
  });
});
