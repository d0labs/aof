import { describe, it, expect } from "vitest";
import { formatAlert } from "../alerting.js";
import type { RestartRecord } from "../restart-tracker.js";
import type { HealthStatus } from "../../../daemon/health.js";

describe("Alerting", () => {
  it("formats alert with restart history", () => {
    const restarts: RestartRecord[] = [
      { timestamp: Date.now() - 10000, reason: "health check failed" },
      { timestamp: Date.now() - 5000, reason: "health check failed" },
      { timestamp: Date.now() - 1000, reason: "health check failed" },
    ];

    const health: HealthStatus = {
      status: "unhealthy",
      uptime: 60000,
      lastPollAt: Date.now() - 10000,
      lastEventAt: Date.now() - 5000,
      taskCounts: {
        open: 5,
        ready: 3,
        inProgress: 2,
        blocked: 1,
        done: 10,
      },
    };

    const alert = formatAlert(restarts, health);

    expect(alert.severity).toBe("critical");
    expect(alert.title).toBe("AOF Daemon Auto-Restart Failed");
    expect(alert.body).toContain("exceeded the auto-restart limit");
    expect(alert.body).toContain("health check failed");
  });

  it("includes all required metadata", () => {
    const restarts: RestartRecord[] = [];
    const health: HealthStatus = {
      status: "unhealthy",
      uptime: 60000,
      lastPollAt: Date.now(),
      lastEventAt: Date.now(),
      taskCounts: {
        open: 0,
        ready: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      },
    };

    const alert = formatAlert(restarts, health);

    expect(alert.metadata.restartHistory).toEqual(restarts);
    expect(alert.metadata.healthStatus).toEqual(health);
  });

  it("includes task counts in alert body", () => {
    const health: HealthStatus = {
      status: "unhealthy",
      uptime: 60000,
      lastPollAt: Date.now(),
      lastEventAt: Date.now(),
      taskCounts: {
        open: 5,
        ready: 3,
        inProgress: 2,
        blocked: 1,
        done: 10,
      },
    };

    const alert = formatAlert([], health);

    expect(alert.body).toContain("Open: 5");
    expect(alert.body).toContain("Ready: 3");
    expect(alert.body).toContain("In Progress: 2");
  });
});
