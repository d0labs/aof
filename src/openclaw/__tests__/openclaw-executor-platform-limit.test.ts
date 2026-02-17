import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenClawExecutor } from "../openclaw-executor.js";
import type { OpenClawApi } from "../types.js";

describe("OpenClawExecutor - Platform Limit Detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should parse platform limit from error message", async () => {
    // Mock API and config
    const mockApi: OpenClawApi = {
      config: { gateway: { port: 3000, auth: { token: "test" } } },
    };
    
    // Mock fetch to return platform limit error
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({
        error: "sessions_spawn has reached max active children for this session (3/2)"
      }),
    });
    
    const executor = new OpenClawExecutor(mockApi);
    const result = await executor.spawn({
      taskId: "test-001",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: { agent: "agent:test:main" },
      projectId: "test-project",
      projectRoot: "/path/to/project",
      taskRelpath: "tasks/test-001.md",
    });
    
    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(2);
    expect(result.error).toContain("max active children");
  });
  
  it("should return undefined platformLimit for non-platform-limit errors", async () => {
    const mockApi: OpenClawApi = {
      config: { gateway: { port: 3000, auth: { token: "test" } } },
    };
    
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "Agent not found" }),
    });
    
    const executor = new OpenClawExecutor(mockApi);
    const result = await executor.spawn({
      taskId: "test-002",
      taskPath: "/path/to/task.md",
      agent: "agent:nonexistent:main",
      priority: "medium",
      routing: { agent: "agent:nonexistent:main" },
      projectId: "test-project",
      projectRoot: "/path/to/project",
      taskRelpath: "tasks/test-002.md",
    });
    
    expect(result.success).toBe(false);
    expect(result.platformLimit).toBeUndefined();
    expect(result.error).toContain("Agent not found");
  });
  
  it("should handle different number formats in platform limit", async () => {
    const mockApi: OpenClawApi = {
      config: { gateway: { port: 3000, auth: { token: "test" } } },
    };
    
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({
        error: "max active children for this session (10/5)"
      }),
    });
    
    const executor = new OpenClawExecutor(mockApi);
    const result = await executor.spawn({
      taskId: "test-003",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: { agent: "agent:test:main" },
      projectId: "test-project",
      projectRoot: "/path/to/project",
      taskRelpath: "tasks/test-003.md",
    });
    
    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(5);
  });

  it("should handle platform limit in HTTP response JSON details", async () => {
    const mockApi: OpenClawApi = {
      config: { gateway: { port: 3000, auth: { token: "test" } } },
    };
    
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          status: "error",
          error: "sessions_spawn has reached max active children for this session (5/3)"
        }
      }),
    });
    
    const executor = new OpenClawExecutor(mockApi);
    const result = await executor.spawn({
      taskId: "test-004",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: { agent: "agent:test:main" },
      projectId: "test-project",
      projectRoot: "/path/to/project",
      taskRelpath: "tasks/test-004.md",
    });
    
    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(3);
    expect(result.error).toContain("max active children");
  });
});
