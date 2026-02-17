/**
 * Tests for task cancel command.
 * 
 * Requirements:
 * - Cancel command with optional --reason flag
 * - Wired to store.cancel() method
 * - Error handling for not found / terminal state
 * - Confirmation printed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../../store/task-store.js";
import type { ITaskStore } from "../../../store/interfaces.js";
import { EventLogger } from "../../../events/logger.js";
import { taskCancel } from "../task-cancel.js";

describe("Task Cancel Command", () => {
  let testDir: string;
  let store: ITaskStore;
  let eventLogger: EventLogger;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Create temporary directory for test
    testDir = await mkdtemp(join(tmpdir(), "aof-cancel-test-"));
    
    // Create required directories
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "tasks", "in-progress"), { recursive: true });
    await mkdir(join(testDir, "tasks", "done"), { recursive: true });
    await mkdir(join(testDir, "tasks", "cancelled"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });
    
    // Initialize event logger first
    eventLogger = new EventLogger(join(testDir, "events"));
    
    // Initialize store with event logger
    store = new FilesystemTaskStore(testDir, { projectId: "test", logger: eventLogger });

    // Spy on console methods and process.exit
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
    
    // Restore spies
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it("cancels a task without reason", async () => {
    const taskId = "TASK-2026-02-17-001";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: ready
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
---

Test task body`;

    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

    // Cancel the task
    await taskCancel(store, eventLogger, taskId, {});

    // Verify task status changed to cancelled
    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("cancelled");
    
    // Verify confirmation printed
    expect(consoleLogSpy).toHaveBeenCalledWith(`✅ Task cancelled: ${taskId}`);
    expect(consoleLogSpy).toHaveBeenCalledWith(`   Previous status: ready`);
  });

  it("cancels a task with reason", async () => {
    const taskId = "TASK-2026-02-17-002";
    const reason = "No longer needed";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: in-progress
priority: high
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
---

Test task body`;

    await writeFile(join(testDir, "tasks", "in-progress", `${taskId}.md`), taskContent);

    // Cancel the task with reason
    await taskCancel(store, eventLogger, taskId, { reason });

    // Verify task status changed to cancelled
    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("cancelled");
    expect(task?.frontmatter.metadata.cancellationReason).toBe(reason);
    
    // Verify confirmation printed with reason
    expect(consoleLogSpy).toHaveBeenCalledWith(`✅ Task cancelled: ${taskId}`);
    expect(consoleLogSpy).toHaveBeenCalledWith(`   Previous status: in-progress`);
    expect(consoleLogSpy).toHaveBeenCalledWith(`   Reason: ${reason}`);
  });

  it("handles task not found error", async () => {
    const taskId = "TASK-9999-99-99-999";

    // Try to cancel non-existent task
    await taskCancel(store, eventLogger, taskId, {});

    // Verify error printed and process exited
    expect(consoleErrorSpy).toHaveBeenCalledWith(`❌ Task not found: ${taskId}`);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("handles terminal state error (done)", async () => {
    const taskId = "TASK-2026-02-17-003";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: done
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
---

Test task body`;

    await writeFile(join(testDir, "tasks", "done", `${taskId}.md`), taskContent);

    // Try to cancel done task
    await taskCancel(store, eventLogger, taskId, {});

    // Verify error printed and process exited
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Cannot cancel task ${taskId}: already in terminal state 'done'`)
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("handles terminal state error (cancelled)", async () => {
    const taskId = "TASK-2026-02-17-004";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: cancelled
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
metadata:
  cancellationReason: "Already cancelled"
---

Test task body`;

    await writeFile(join(testDir, "tasks", "cancelled", `${taskId}.md`), taskContent);

    // Try to cancel already-cancelled task
    await taskCancel(store, eventLogger, taskId, {});

    // Verify error printed and process exited
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Cannot cancel task ${taskId}: already in terminal state 'cancelled'`)
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("resolves task by prefix", async () => {
    const taskId = "TASK-2026-02-17-005";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: ready
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
---

Test task body`;

    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

    // Cancel using prefix instead of full ID
    await taskCancel(store, eventLogger, "TASK-2026-02-17-005", {});

    // Verify task was cancelled
    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("cancelled");
  });

  it("logs cancellation event", async () => {
    const taskId = "TASK-2026-02-17-006";
    const reason = "Duplicate work";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: ready
priority: normal
createdAt: 2026-02-17T00:00:00Z
updatedAt: 2026-02-17T00:00:00Z
lastTransitionAt: 2026-02-17T00:00:00Z
createdBy: system
routing:
  agent: swe-backend
---

Test task body`;

    await writeFile(join(testDir, "tasks", "ready", `${taskId}.md`), taskContent);

    // Cancel the task
    await taskCancel(store, eventLogger, taskId, { reason });

    // Read events log
    const eventsLog = await readFile(join(testDir, "events", "events.jsonl"), "utf-8");
    const events = eventsLog.trim().split("\n").map(line => JSON.parse(line));
    
    // Check for cancellation event
    const cancelEvent = events.find(e => e.type === "task.cancelled");
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent?.taskId).toBe(taskId);
    expect(cancelEvent?.payload.reason).toBe(reason);
    expect(cancelEvent?.payload.from).toBe("ready");
  });
});
