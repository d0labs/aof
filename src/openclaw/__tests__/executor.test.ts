import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenClawExecutor } from "../executor.js";
import type { OpenClawApi } from "../types.js";
import type { TaskContext } from "../../dispatch/executor.js";

describe("OpenClawExecutor", () => {
  let mockApi: OpenClawApi;
  let executor: OpenClawExecutor;

  beforeEach(() => {
    mockApi = {
      spawnAgent: vi.fn(),
    } as unknown as OpenClawApi;
    executor = new OpenClawExecutor(mockApi);
  });

  it("spawns agent session successfully", async () => {
    const mockSessionId = "session-12345";
    (mockApi.spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      sessionId: mockSessionId,
    });

    const context: TaskContext = {
      taskId: "TASK-001",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "high",
      routing: { role: "backend-engineer" },
    };

    const result = await executor.spawn(context);

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe(mockSessionId);
    expect(mockApi.spawnAgent).toHaveBeenCalledWith({
      agentId: "swe-backend",
      task: expect.stringContaining("TASK-001"),
      context: {
        taskId: "TASK-001",
        taskPath: "/path/to/task.md",
        priority: "high",
        routing: { role: "backend-engineer" },
      },
    });
  });

  it("handles spawn failure gracefully", async () => {
    (mockApi.spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "Agent not found",
    });

    const context: TaskContext = {
      taskId: "TASK-002",
      taskPath: "/path/to/task.md",
      agent: "nonexistent-agent",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawn(context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent not found");
    expect(result.sessionId).toBeUndefined();
  });

  it("respects timeout option", async () => {
    (mockApi.spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      sessionId: "session-timeout",
    });

    const context: TaskContext = {
      taskId: "TASK-003",
      taskPath: "/path/to/task.md",
      agent: "swe-qa",
      priority: "low",
      routing: {},
    };

    await executor.spawn(context, { timeoutMs: 60000 });

    expect(mockApi.spawnAgent).toHaveBeenCalledWith({
      agentId: "swe-qa",
      task: expect.any(String),
      context: expect.any(Object),
      timeoutMs: 60000,
    });
  });

  it("includes routing metadata in spawn call", async () => {
    (mockApi.spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      sessionId: "session-routing",
    });

    const context: TaskContext = {
      taskId: "TASK-004",
      taskPath: "/path/to/task.md",
      agent: "swe-frontend",
      priority: "critical",
      routing: {
        role: "frontend-engineer",
        team: "swe",
        tags: ["ui", "react"],
      },
    };

    await executor.spawn(context);

    expect(mockApi.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          routing: {
            role: "frontend-engineer",
            team: "swe",
            tags: ["ui", "react"],
          },
        }),
      }),
    );
  });

  it("handles API exceptions", async () => {
    (mockApi.spawnAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error"),
    );

    const context: TaskContext = {
      taskId: "TASK-005",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawn(context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
  });

  it("includes aof_task_complete instruction with taskId", async () => {
    (mockApi.spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      sessionId: "session-complete-instruction",
    });

    const context: TaskContext = {
      taskId: "TASK-006",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    await executor.spawn(context);

    expect(mockApi.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("aof_task_complete"),
      }),
    );
    expect(mockApi.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining('taskId="TASK-006"'),
      }),
    );
  });

  it("normalizes agent ID by trying multiple formats", async () => {
    // First call fails, second succeeds
    (mockApi.spawnAgent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: false,
        error: "Agent not found",
      })
      .mockResolvedValueOnce({
        success: true,
        sessionId: "session-normalized",
      });

    const context: TaskContext = {
      taskId: "TASK-007",
      taskPath: "/path/to/task.md",
      agent: "swe-backend",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawn(context);

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("session-normalized");
    expect(mockApi.spawnAgent).toHaveBeenCalledTimes(2);
    
    // First call with raw agent ID
    expect(mockApi.spawnAgent).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        agentId: "swe-backend",
      }),
    );
    
    // Second call with normalized agent ID
    expect(mockApi.spawnAgent).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        agentId: "agent:swe-backend:main",
      }),
    );
  });

  it("handles graceful fallback when agent not found in any format", async () => {
    (mockApi.spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "Agent not found",
    });

    const context: TaskContext = {
      taskId: "TASK-008",
      taskPath: "/path/to/task.md",
      agent: "nonexistent-agent",
      priority: "normal",
      routing: {},
    };

    const result = await executor.spawn(context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent not found");
    expect(mockApi.spawnAgent).toHaveBeenCalledTimes(2); // Tried both formats
  });
});
