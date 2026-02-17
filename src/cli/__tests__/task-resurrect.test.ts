/**
 * Tests for task resurrection command.
 * 
 * Following AOF-p3k requirements:
 * - Resurrection command transitions deadletter → ready
 * - Task file moved from tasks/deadletter/ back to tasks/ready/
 * - Dispatch failure count reset to 0
 * - Resurrection logged to events.jsonl
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import { resurrectTask } from "../task-resurrect.js";

describe("Task Resurrection", () => {
  let testDir: string;
  let store: ITaskStore;
  let eventLogger: EventLogger;

  beforeEach(async () => {
    // Create temporary directory for test
    testDir = await mkdtemp(join(tmpdir(), "aof-resurrect-test-"));
    
    // Create required directories
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "tasks", "deadletter"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });
    
    // Initialize store and event logger
    store = new FilesystemTaskStore(testDir, { projectId: "test" });
    eventLogger = new EventLogger(join(testDir, "events"));
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  it("resurrectTask transitions deadletter → ready", async () => {
    const taskId = "TASK-2026-02-13-001";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: deadletter
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

    await writeFile(join(testDir, "tasks", "deadletter", `${taskId}.md`), taskContent);

    // Resurrect the task
    await resurrectTask(store, eventLogger, taskId, "xavier");

    // Verify task status changed to ready
    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("ready");
  });

  it("resurrectTask moves task file from deadletter to ready", async () => {
    const taskId = "TASK-2026-02-13-002";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: deadletter
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
metadata:
  dispatchFailures: 3
---

Test task body`;

    await writeFile(join(testDir, "tasks", "deadletter", `${taskId}.md`), taskContent);

    // Resurrect the task
    await resurrectTask(store, eventLogger, taskId, "xavier");

    // Check file was moved to ready
    const readyFiles = await readdir(join(testDir, "tasks", "ready"));
    expect(readyFiles).toContain(`${taskId}.md`);

    // Check original file was removed from deadletter
    const deadletterFiles = await readdir(join(testDir, "tasks", "deadletter"));
    expect(deadletterFiles).not.toContain(`${taskId}.md`);
  });

  it("resurrectTask resets dispatch failure count", async () => {
    const taskId = "TASK-2026-02-13-003";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: deadletter
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
metadata:
  dispatchFailures: 3
  lastDispatchFailureReason: "agent not available"
  lastDispatchFailureAt: 1707850200000
---

Test task body`;

    await writeFile(join(testDir, "tasks", "deadletter", `${taskId}.md`), taskContent);

    // Resurrect the task
    await resurrectTask(store, eventLogger, taskId, "xavier");

    // Verify failure count was reset
    const task = await store.get(taskId);
    expect(task?.frontmatter.metadata.dispatchFailures).toBe(0);
    expect(task?.frontmatter.metadata.lastDispatchFailureReason).toBeUndefined();
    expect(task?.frontmatter.metadata.lastDispatchFailureAt).toBeUndefined();
  });

  it("resurrectTask logs resurrection event", async () => {
    const taskId = "TASK-2026-02-13-004";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: deadletter
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
metadata:
  dispatchFailures: 3
---

Test task body`;

    await writeFile(join(testDir, "tasks", "deadletter", `${taskId}.md`), taskContent);

    // Resurrect the task
    await resurrectTask(store, eventLogger, taskId, "xavier");

    // Read events log
    const eventsLog = await readFile(join(testDir, "events", "events.jsonl"), "utf-8");
    const events = eventsLog.trim().split("\n").map(line => JSON.parse(line));
    
    // Check for resurrection event
    const resurrectionEvent = events.find(e => e.type === "task.resurrected");
    expect(resurrectionEvent).toBeDefined();
    expect(resurrectionEvent?.taskId).toBe(taskId);
    expect(resurrectionEvent?.payload.resurrectedBy).toBe("xavier");
  });

  it("resurrectTask throws error if task not in deadletter", async () => {
    const taskId = "TASK-2026-02-13-999";

    // Try to resurrect non-existent task
    await expect(
      resurrectTask(store, eventLogger, taskId, "xavier")
    ).rejects.toThrow(`Task ${taskId} not found in deadletter queue`);
  });
});
