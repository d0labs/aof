import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenClawAdapter } from "../openclaw-executor.js";
import type { OpenClawApi } from "../types.js";

const mockRunEmbeddedPiAgent = vi.fn();
const mockExtApi = {
  runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/ws"),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  ensureAgentWorkspace: vi.fn(async (p: { dir: string }) => ({ dir: p.dir })),
  resolveSessionFilePath: vi.fn((id: string) => `/tmp/s/${id}.jsonl`),
};

describe("OpenClawAdapter - Platform Limit Detection", () => {
  let executor: OpenClawAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockApi = { config: { agents: {} } } as unknown as OpenClawApi;
    executor = new OpenClawAdapter(mockApi);
    (executor as any).extensionApi = mockExtApi;
  });

  it("should parse platform limit from thrown error message", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(
      new Error("sessions_spawn has reached max active children for this session (3/2)"),
    );

    const result = await executor.spawnSession({
      taskId: "test-001",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: { agent: "agent:test:main" },
    });

    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(2);
    expect(result.error).toContain("max active children");
  });

  it("should return undefined platformLimit for non-platform-limit errors", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("Agent not found"));

    const result = await executor.spawnSession({
      taskId: "test-002",
      taskPath: "/path/to/task.md",
      agent: "agent:nonexistent:main",
      priority: "medium",
      routing: {},
    });

    expect(result.success).toBe(false);
    expect(result.platformLimit).toBeUndefined();
    expect(result.error).toContain("Agent not found");
  });

  it("should handle different number formats in platform limit", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(
      new Error("max active children for this session (10/5)"),
    );

    const result = await executor.spawnSession({
      taskId: "test-003",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: {},
    });

    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(5);
  });

  it("should handle platform limit in result meta error", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      meta: {
        durationMs: 100,
        error: {
          kind: "retry_limit",
          message: "sessions_spawn has reached max active children for this session (5/3)",
        },
      },
    });

    const result = await executor.spawnSession({
      taskId: "test-004",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("max active children");
  });
});
