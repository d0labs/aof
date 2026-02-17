/**
 * Tests for deadletter status and state transitions.
 * 
 * Following the task brief AOF-p3k requirements:
 * - TaskStatus includes "deadletter"
 * - Valid transitions: ready → deadletter, deadletter → ready
 * - State machine correctly validates transitions
 */

import { describe, it, expect } from "vitest";
import { TaskStatus, VALID_TRANSITIONS, isValidTransition } from "../task.js";

describe("Deadletter Status", () => {
  it("TaskStatus enum includes deadletter", () => {
    // Parse the deadletter status
    const result = TaskStatus.safeParse("deadletter");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("deadletter");
    }
  });

  it("Transition ready → deadletter is valid", () => {
    const isValid = isValidTransition("ready", "deadletter");
    expect(isValid).toBe(true);
  });

  it("Transition deadletter → ready is valid", () => {
    const isValid = isValidTransition("deadletter", "ready");
    expect(isValid).toBe(true);
  });

  it("Transition deadletter → in-progress is invalid (must go through ready)", () => {
    const isValid = isValidTransition("deadletter", "in-progress");
    expect(isValid).toBe(false);
  });

  it("Transition backlog → deadletter is invalid", () => {
    const isValid = isValidTransition("backlog", "deadletter");
    expect(isValid).toBe(false);
  });

  it("Transition deadletter → done is invalid", () => {
    const isValid = isValidTransition("deadletter", "done");
    expect(isValid).toBe(false);
  });

  it("VALID_TRANSITIONS includes deadletter entry", () => {
    expect(VALID_TRANSITIONS).toHaveProperty("deadletter");
    expect(VALID_TRANSITIONS.deadletter).toContain("ready");
  });

  it("VALID_TRANSITIONS allows ready to transition to deadletter", () => {
    expect(VALID_TRANSITIONS.ready).toContain("deadletter");
  });
});
