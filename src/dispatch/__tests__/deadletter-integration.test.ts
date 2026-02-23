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

  it("threshold boundary: 2 failures do not trigger deadletter", async () => {
    const taskId = "TASK-2026-02-13-010";
    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), `---
schemaVersion: 1
id: ${taskId}
project: test
title: Boundary Task
status: ready
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
metadata: {}
---

Task body`);

    await trackDispatchFailure(store, taskId, "failure 1");
    await trackDispatchFailure(store, taskId, "failure 2");

    const task = await store.get(taskId);
    // ODD: shouldTransitionToDeadletter is the observable gate — must be false at 2
    expect(shouldTransitionToDeadletter(task!)).toBe(false);
    expect(task?.frontmatter.metadata.dispatchFailures).toBe(2);
    expect(task?.frontmatter.status).toBe("ready");
  });

  it("threshold boundary: exactly 3 failures triggers deadletter event", async () => {
    const taskId = "TASK-2026-02-13-011";
    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), `---
schemaVersion: 1
id: ${taskId}
project: test
title: Exact Threshold Task
status: ready
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
metadata: {}
---

Task body`);

    await trackDispatchFailure(store, taskId, "failure 1");
    await trackDispatchFailure(store, taskId, "failure 2");
    await trackDispatchFailure(store, taskId, "failure 3");

    const task = await store.get(taskId);
    expect(shouldTransitionToDeadletter(task!)).toBe(true);

    await transitionToDeadletter(store, eventLogger, taskId, "failure 3");

    // ODD event: task.deadletter with failureCount=3
    const eventsLog = await readFile(join(testDir, "events", "events.jsonl"), "utf-8");
    const events = eventsLog.trim().split("\n").map(l => JSON.parse(l));
    const deadletterEvent = events.find(e => e.type === "task.deadletter");
    expect(deadletterEvent?.payload.failureCount).toBe(3);
    expect(deadletterEvent?.payload.lastFailureReason).toBe("failure 3");

    // ODD filesystem: task is in deadletter dir
    const dlTask = await store.get(taskId);
    expect(dlTask?.frontmatter.status).toBe("deadletter");
  });

  it("ODD: failure reason recorded in metadata and event log", async () => {
    const taskId = "TASK-2026-02-13-012";
    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), `---
schemaVersion: 1
id: ${taskId}
project: test
title: Reason Tracking Task
status: ready
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
metadata: {}
---

Task body`);

    const specificReason = "Agent swe-backend timed out after 30s";
    await trackDispatchFailure(store, taskId, specificReason);

    const task = await store.get(taskId);
    // ODD: failure reason persisted in task metadata
    expect(task?.frontmatter.metadata.lastDispatchFailureReason).toBe(specificReason);
    expect(task?.frontmatter.metadata.dispatchFailures).toBe(1);
  });

  it("resurrection resets failure counter and allows re-dispatch", async () => {
    const taskId = "TASK-2026-02-13-013";
    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), `---
schemaVersion: 1
id: ${taskId}
project: test
title: Resurrection Counter Task
status: ready
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
metadata: {}
---

Task body`);

    // Fail 3 times and deadletter
    await trackDispatchFailure(store, taskId, "fail 1");
    await trackDispatchFailure(store, taskId, "fail 2");
    await trackDispatchFailure(store, taskId, "fail 3");
    await transitionToDeadletter(store, eventLogger, taskId, "fail 3");

    // Resurrect
    await resurrectTask(store, eventLogger, taskId, "ops-team");

    const task = await store.get(taskId);
    // ODD: counter reset to 0 after resurrection
    expect(task?.frontmatter.metadata.dispatchFailures).toBe(0);
    expect(task?.frontmatter.status).toBe("ready");

    // ODD: shouldTransitionToDeadletter is false again
    expect(shouldTransitionToDeadletter(task!)).toBe(false);
  });
});
