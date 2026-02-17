/**
 * Tests for task close command with recovery support.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../../store/task-store.js";
import { EventLogger } from "../../../events/logger.js";
import { taskClose } from "../task-close.js";

describe("Task Close Command", () => {
  let testDir: string;
  let store: TaskStore;
  let eventLogger: EventLogger;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "aof-task-close-test-"));
    
    await mkdir(join(testDir, "tasks", "in-progress"), { recursive: true });
    await mkdir(join(testDir, "tasks", "done"), { recursive: true });
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });
    
    eventLogger = new EventLogger(join(testDir, "events"));
    store = new TaskStore(testDir, { projectId: "test", logger: eventLogger });
    
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("closes task successfully", async () => {
    const taskId = "TASK-2026-02-13-001";
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: review
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
metadata: {}
---

Test task body`;

    await mkdir(join(testDir, "tasks", "review"), { recursive: true });
    await writeFile(join(testDir, "tasks", "review", `${taskId}.md`), taskContent);

    await taskClose(store, eventLogger, taskId);
    
    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("done");
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("✅ Task"));
  });

  it("fails without recovery flag", async () => {
    const taskId = "TASK-2026-02-13-999";

    await taskClose(store, eventLogger, taskId, { recoverOnFailure: false });
    
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("❌ Failed"));
    expect(process.exitCode).toBe(1);
    
    // Reset exit code for other tests
    process.exitCode = 0;
  });

  it("attempts recovery with --recover-on-failure flag", async () => {
    const taskId = "TASK-2026-02-13-002";
    const expiredTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    
    const taskContent = `---
schemaVersion: 1
id: ${taskId}
project: test
title: Test Task
status: in-progress
priority: normal
createdAt: 2026-02-13T00:00:00Z
updatedAt: 2026-02-13T00:00:00Z
lastTransitionAt: 2026-02-13T00:00:00Z
createdBy: system
lease:
  agent: test-agent
  acquiredAt: ${expiredTime}
  expiresAt: ${new Date(new Date(expiredTime).getTime() + 10 * 60 * 1000).toISOString()}
  renewCount: 0
metadata: {}
---

Test task body`;

    await writeFile(join(testDir, "tasks", "in-progress", `${taskId}.md`), taskContent);

    // Close will fail because in-progress → done is invalid (requires review state first)
    // Recovery should detect expired lease and transition task to ready
    await taskClose(store, eventLogger, taskId, { recoverOnFailure: true });
    
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("❌ Failed"));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("🔧 Recovery triggered"));
  });
});
