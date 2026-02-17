/**
 * Integration test for complete deadletter flow.
 * 
 * Tests the full workflow:
 * 1. Task fails dispatch 3 times
 * 2. Task transitions to deadletter
 * 3. Task is resurrected back to ready
 * 4. All events are logged correctly
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { trackDispatchFailure, shouldTransitionToDeadletter, transitionToDeadletter } from "../failure-tracker.js";
import { resurrectTask } from "../../cli/task-resurrect.js";

describe("Deadletter Integration", () => {
  let testDir: string;
  let store: ITaskStore;
  let eventLogger: EventLogger;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "aof-integration-test-"));
    
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "tasks", "deadletter"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });
    
    eventLogger = new EventLogger(join(testDir, "events"));
    store = new FilesystemTaskStore(testDir, { projectId: "test", logger: eventLogger });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("complete flow: 3 failures → deadletter → resurrection", async () => {
    // Step 1: Create a task in ready state
    const taskId = "TASK-2026-02-13-001";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: ready
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
metadata: {}
---

Test task body`;

    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

    // Step 2: Fail dispatch 3 times
    await trackDispatchFailure(store, taskId, "agent not available");
    await trackDispatchFailure(store, taskId, "agent timeout");
    await trackDispatchFailure(store, taskId, "agent crashed");

    // Step 3: Check if should transition to deadletter
    let task = await store.get(taskId);
    expect(shouldTransitionToDeadletter(task!)).toBe(true);

    // Step 4: Transition to deadletter
    await transitionToDeadletter(store, eventLogger, taskId, "agent crashed");

    // Step 5: Verify task is in deadletter
    task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("deadletter");
    expect(task?.frontmatter.metadata.dispatchFailures).toBe(3);

    // Step 6: Resurrect the task
    await resurrectTask(store, eventLogger, taskId, "xavier");

    // Step 7: Verify task is back in ready state
    task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("ready");
    expect(task?.frontmatter.metadata.dispatchFailures).toBe(0);
    expect(task?.frontmatter.metadata.lastDispatchFailureReason).toBeUndefined();

    // Step 8: Verify all events were logged
    const eventsLog = await readFile(join(testDir, "events", "events.jsonl"), "utf-8");
    const events = eventsLog.trim().split("\n").map(line => JSON.parse(line));

    // Check for deadletter event
    const deadletterEvent = events.find(e => e.type === "task.deadletter");
    expect(deadletterEvent).toBeDefined();
    expect(deadletterEvent?.payload.failureCount).toBe(3);

    // Check for resurrection event
    const resurrectionEvent = events.find(e => e.type === "task.resurrected");
    expect(resurrectionEvent).toBeDefined();
    expect(resurrectionEvent?.payload.resurrectedBy).toBe("xavier");

    // Check for transition events
    const transitionEvents = events.filter(e => e.type === "task.transitioned");
    expect(transitionEvents.length).toBeGreaterThanOrEqual(2);
  });
});
