import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHealthServer, type DaemonStateProvider } from "../server.js";
import type { TaskStore } from "../../store/task-store.js";
import type { Server } from "node:http";

describe("Health Endpoint Server", () => {
  let server: Server;
  let mockStateProvider: DaemonStateProvider;
  let mockStore: TaskStore;
  const testPort = 13000;

  beforeEach(() => {
    mockStateProvider = vi.fn(() => ({
      lastPollAt: Date.now(),
      lastEventAt: Date.now(),
      uptime: 60_000,
    }));

    mockStore = {
      countByStatus: vi.fn().mockResolvedValue({
        backlog: 2,
        ready: 3,
        "in-progress": 2,
        blocked: 1,
        review: 0,
        done: 10,
        deadletter: 0,
      }),
    } as unknown as TaskStore;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("GET /health returns 200 when healthy", async () => {
    server = createHealthServer(mockStateProvider, mockStore, testPort);

    const response = await fetch(`http://localhost:${testPort}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.uptime).toBe(60_000);
  });

  it("GET /health returns 503 when unhealthy", async () => {
    mockStateProvider = vi.fn(() => ({
      lastPollAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      lastEventAt: Date.now(),
      uptime: 60_000,
    }));

    server = createHealthServer(mockStateProvider, mockStore, testPort);

    const response = await fetch(`http://localhost:${testPort}/health`);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("unhealthy");
  });

  it("GET /health includes task counts", async () => {
    server = createHealthServer(mockStateProvider, mockStore, testPort);

    const response = await fetch(`http://localhost:${testPort}/health`);
    const body = await response.json();

    expect(body.taskCounts).toEqual({
      open: 2,
      ready: 3,
      inProgress: 2,
      blocked: 1,
      done: 10,
    });
  });

  it("GET /health is publicly accessible (no auth)", async () => {
    server = createHealthServer(mockStateProvider, mockStore, testPort);

    const response = await fetch(`http://localhost:${testPort}/health`);

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });
});
