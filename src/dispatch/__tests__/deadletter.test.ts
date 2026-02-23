/**
 * Tests for dispatch failure tracking and deadletter transitions.
 * 
 * Following AOF-p3k requirements:
 * - Dispatch failures are tracked in task metadata
 * - After 3 failures, task transitions to deadletter
 * - Task file moves to tasks/deadletter/
 * - Events are logged for deadletter transitions
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { trackDispatchFailure, shouldTransitionToDeadletter, transitionToDeadletter } from "../failure-tracker.js";
import type { Task } from "../../schemas/task.js";
import type { BaseEvent } from "../../schemas/event.js";

describe("Dispatch Failure Tracking", () => {
  let testDir: string;
  let store: ITaskStore;
  let eventLogger: EventLogger;
  let capturedEvents: BaseEvent[];

  beforeEach(async () => {
    // Create temporary directory for test
    testDir = await mkdtemp(join(tmpdir(), "aof-deadletter-test-"));

    // Create required directories
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "tasks", "deadletter"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });

    // Initialize store and event logger with in-memory capture
    capturedEvents = [];
    store = new FilesystemTaskStore(testDir, { projectId: "test" });
    eventLogger = new EventLogger(join(testDir, "events"), {
      onEvent: (event) => capturedEvents.push(event),
    });
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  it("trackDispatchFailure increments failure count", async () => {
    // Create a test task
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

    // Track first failure
    await trackDispatchFailure(store, taskId, "agent not available");
    
    let task = await store.get(taskId);
    expect(task?.frontmatter.metadata.dispatchFailures).toBe(1);
    expect(task?.frontmatter.metadata.lastDispatchFailureReason).toBe("agent not available");
  });

  it("shouldTransitionToDeadletter returns true after 3 failures", async () => {
    const taskId = "TASK-2026-02-13-002";
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
metadata:
  dispatchFailures: 3
---

Test task body`;

    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

    const task = await store.get(taskId);
    const shouldTransition = shouldTransitionToDeadletter(task!);
    expect(shouldTransition).toBe(true);
  });

  it("shouldTransitionToDeadletter returns false before 3 failures", async () => {
    const taskId = "TASK-2026-02-13-003";
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
metadata:
  dispatchFailures: 2
---

Test task body`;

    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

    const task = await store.get(taskId);
    const shouldTransition = shouldTransitionToDeadletter(task!);
    expect(shouldTransition).toBe(false);
  });

  it("transitionToDeadletter moves task file to deadletter directory", async () => {
    const taskId = "TASK-2026-02-13-004";
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
metadata:
  dispatchFailures: 3
---

Test task body`;

    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

    // Transition to deadletter
    await transitionToDeadletter(store, eventLogger, taskId, "agent not available");

    // Check file was moved
    const deadletterFiles = await readdir(join(testDir, "tasks", "deadletter"));
    expect(deadletterFiles).toContain(`${taskId}.md`);

    // Check original file was removed
    const readyFiles = await readdir(join(testDir, "tasks", "ready"));
    expect(readyFiles).not.toContain(`${taskId}.md`);

    // Verify task status was updated
    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("deadletter");
  });

  it("transitionToDeadletter emits task.deadletter event with ops context", async () => {
    const taskId = "TASK-2026-02-13-006";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Alert Test Task
status: ready
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
metadata:
  dispatchFailures: 3
  lastDispatchFailureReason: test failure 3
---

Test task body`;

    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

    // Transition to deadletter
    await transitionToDeadletter(store, eventLogger, taskId, "test failure 3");

    // ODD: assert on task.deadletter event, not console.error text
    const deadletterEvent = capturedEvents.find(e => e.type === "task.deadletter");
    expect(deadletterEvent).toBeDefined();
    expect(deadletterEvent?.taskId).toBe(taskId);
    expect(deadletterEvent?.payload.reason).toBe("max_dispatch_failures");
    expect(deadletterEvent?.payload.failureCount).toBe(3);
    expect(deadletterEvent?.payload.lastFailureReason).toBe("test failure 3");

    // Filesystem state: task is in deadletter directory
    const deadletterFiles = await readdir(join(testDir, "tasks", "deadletter"));
    expect(deadletterFiles).toContain(`${taskId}.md`);
  });

  it("transitionToDeadletter logs event", async () => {
    const taskId = "TASK-2026-02-13-005";
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
metadata:
  dispatchFailures: 3
  lastDispatchFailureReason: "agent not available"
---

Test task body`;

    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

    // Transition to deadletter
    await transitionToDeadletter(store, eventLogger, taskId, "agent not available");

    // Read events log
    const eventsLog = await readFile(join(testDir, "events", "events.jsonl"), "utf-8");
    const events = eventsLog.trim().split("\n").map(line => JSON.parse(line));
    
    // Check for deadletter event
    const deadletterEvent = events.find(e => e.type === "task.deadletter");
    expect(deadletterEvent).toBeDefined();
    expect(deadletterEvent?.taskId).toBe(taskId);
    expect(deadletterEvent?.payload.reason).toBe("max_dispatch_failures");
    expect(deadletterEvent?.payload.failureCount).toBe(3);
  });
});
