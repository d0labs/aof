import { describe, it, expect, beforeEach } from "vitest";
import { RestartTracker, createRestartTracker } from "../restart-tracker.js";

describe("RestartTracker", () => {
  let tracker: RestartTracker;

  beforeEach(() => {
    tracker = createRestartTracker({
      maxRestarts: 3,
      windowMs: 60 * 60 * 1000, // 1 hour
    });
  });

  it("allows restart when under limit", () => {
    expect(tracker.canRestart()).toBe(true);
  });

  it("records restart with timestamp and reason", () => {
    tracker.recordRestart("health check failed");

    const history = tracker.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe("health check failed");
    expect(history[0].timestamp).toBeGreaterThan(0);
  });

  it("allows up to maxRestarts within window", () => {
    tracker.recordRestart("restart 1");
    tracker.recordRestart("restart 2");
    tracker.recordRestart("restart 3");

    expect(tracker.canRestart()).toBe(false);
  });

  it("prunes old restarts outside window", () => {
    const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago

    // Manually add an old restart
    tracker.recordRestart("old restart");
    const history = tracker.getHistory();
    history[0].timestamp = oldTimestamp;

    // Add new restart
    tracker.recordRestart("new restart");

    // Old restart should be pruned, allowing more restarts
    expect(tracker.canRestart()).toBe(true);
  });

  it("counts only restarts within the window", () => {
    const now = Date.now();
    
    // Add 2 old restarts (outside window)
    tracker.recordRestart("old 1");
    tracker.recordRestart("old 2");
    const history = tracker.getHistory();
    history[0].timestamp = now - 2 * 60 * 60 * 1000;
    history[1].timestamp = now - 2 * 60 * 60 * 1000;

    // Add 2 recent restarts (within window)
    tracker.recordRestart("recent 1");
    tracker.recordRestart("recent 2");

    // Should still allow restart (only 2 within window)
    expect(tracker.canRestart()).toBe(true);
  });

  it("returns empty history initially", () => {
    expect(tracker.getHistory()).toEqual([]);
  });
});
