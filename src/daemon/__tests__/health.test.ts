import { describe, it, expect, vi, beforeEach } from "vitest";
import { getHealthStatus, type DaemonState } from "../health.js";
import type { ITaskStore } from "../../store/interfaces.js";

describe("Daemon Health", () => {
  let mockState: DaemonState;
  let mockStore: ITaskStore;

  beforeEach(() => {
    mockState = {
      lastPollAt: Date.now(),
      lastEventAt: Date.now(),
      uptime: 60_000,
    };

    mockStore = {
      countByStatus: vi.fn().mockResolvedValue({
        backlog: 5,
        ready: 3,
        "in-progress": 2,
        blocked: 1,
        done: 10,
      }),
    } as unknown as TaskStore;
  });

  it("returns healthy status when scheduler is active", async () => {
    const health = await getHealthStatus(mockState, mockStore);

    expect(health.status).toBe("healthy");
    expect(health.uptime).toBe(60_000);
    expect(health.taskCounts).toEqual({
      open: 5,
      ready: 3,
      inProgress: 2,
      blocked: 1,
      done: 10,
    });
  });

  it("returns unhealthy when scheduler hasn't polled in 5min", async () => {
    mockState.lastPollAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago

    const health = await getHealthStatus(mockState, mockStore);

    expect(health.status).toBe("unhealthy");
  });

  it("returns healthy when last poll is within 5min threshold", async () => {
    mockState.lastPollAt = Date.now() - 4 * 60 * 1000; // 4 minutes ago

    const health = await getHealthStatus(mockState, mockStore);

    expect(health.status).toBe("healthy");
  });

  it("includes lastPollAt and lastEventAt timestamps", async () => {
    const health = await getHealthStatus(mockState, mockStore);

    expect(health.lastPollAt).toBe(mockState.lastPollAt);
    expect(health.lastEventAt).toBe(mockState.lastEventAt);
  });

  it("returns unhealthy if store.countByStatus throws error", async () => {
    mockStore.countByStatus = vi.fn().mockRejectedValue(new Error("Store error"));

    const health = await getHealthStatus(mockState, mockStore);

    expect(health.status).toBe("unhealthy");
  });

  it("completes health check in under 50ms", async () => {
    const start = performance.now();
    await getHealthStatus(mockState, mockStore);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(50);
  });
});
