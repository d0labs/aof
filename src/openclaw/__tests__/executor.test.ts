import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenClawAdapter } from "../executor.js";
import type { OpenClawApi } from "../types.js";
import type { TaskContext } from "../../dispatch/executor.js";

const mockRunEmbeddedPiAgent = vi.fn();
const mockExtApi = {
  runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/ws"),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  ensureAgentWorkspace: vi.fn(async (p: { dir: string }) => ({ dir: p.dir })),
  resolveSessionFilePath: vi.fn((id: string) => `/tmp/s/${id}.jsonl`),
};

describe("OpenClawAdapter", () => {
  let mockApi: OpenClawApi;
  let executor: OpenClawAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = { config: { agents: {} } } as unknown as OpenClawApi;
    executor = new OpenClawAdapter(mockApi);
    (executor as any).extensionApi = mockExtApi;
  });

  it("spawns agent session successfully", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "session-12345", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "high",
      routing: { role: "backend-engineer" },
    };

    const result = await executor.spawnSession(context);

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("session-12345");
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "swe-backend",
        prompt: expect.stringContaining("TASK-001"),
      }),
    );
  });

  it("handles spawn failure gracefully", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 500, error: { kind: "retry_limit", message: "Agent not found" } },
    });

    const context: TaskContext = {
      taskId: "TASK-002",
      taskPath: "/path/to/task.md",
      agent: "nonexistent-agent",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawnSession(context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent not found");
  });

  it("respects timeout option", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-t", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-003",
      taskPath: "/path/to/task.md",
      agent: "swe-qa",
      priority: "low",
      routing: {},
    };

    await executor.spawnSession(context, { timeoutMs: 60000 });

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 60000 }),
    );
  });

  it("includes routing metadata in prompt", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-r", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-004",
      taskPath: "/path/to/task.md",
      agent: "swe-frontend",
      priority: "critical",
      routing: { role: "frontend-engineer", team: "swe", tags: ["ui", "react"] },
    };

    await executor.spawnSession(context);

    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("frontend-engineer");
  });

  it("handles API exceptions", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("Network error"));

    const context: TaskContext = {
      taskId: "TASK-005",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawnSession(context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
  });

  it("includes aof_task_complete instruction with taskId", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-c", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-006",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    const params = mockRunEmbeddedPiAgent.mock.calls[0][0];
    expect(params.prompt).toContain("aof_task_complete");
    expect(params.prompt).toContain('taskId="TASK-006"');
  });

  it("normalizes agent:prefix:suffix to agent name", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: { durationMs: 1000, agentMeta: { sessionId: "s-n", provider: "a", model: "m" } },
    });

    const context: TaskContext = {
      taskId: "TASK-007",
      taskPath: "/path/to/task.md",
      agent: "agent:swe-backend:main",
      priority: "normal",
      routing: {},
    };

    await executor.spawnSession(context);

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "swe-backend" }),
    );
  });

  it("handles missing config gracefully", async () => {
    const noConfigApi = {} as unknown as OpenClawApi;
    const exec = new OpenClawAdapter(noConfigApi);
    (exec as any).extensionApi = mockExtApi;

    const result = await exec.spawnSession({
      taskId: "TASK-008",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("config");
  });
});
