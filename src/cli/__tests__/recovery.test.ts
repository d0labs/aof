/**
 * Tests for CLI recovery logic.
 * 
 * Following AOF-l7y requirements:
 * - Check lease expiry (TTL exceeded)
 * - Check heartbeat staleness (>10min)
 * - Expire lease and reclaim task to ready
 * - Log recovery actions to events.jsonl
 * - Format recovery summary for user
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../store/task-store.js";
import { EventLogger } from "../../events/logger.js";
import { attemptRecovery, formatRecoverySummary, type RecoveryResult } from "../recovery.js";

describe("CLI Recovery Logic", () => {
  let testDir: string;
  let store: TaskStore;
  let eventLogger: EventLogger;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "aof-recovery-test-"));
    
    await mkdir(join(testDir, "tasks", "in-progress"), { recursive: true });
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });
    
    eventLogger = new EventLogger(join(testDir, "events"));
    store = new TaskStore(testDir, { projectId: "test", logger: eventLogger });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("detects expired lease and recovers", async () => {
    const taskId = "TASK-2026-02-13-001";
    const expiredTime = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 minutes ago
    
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

    const result = await attemptRecovery(store, eventLogger, taskId);
    
    expect(result.recovered).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe("lease_expired");
    
    // Verify task transitioned to ready
    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("ready");
    expect(task?.frontmatter.lease).toBeUndefined();
  });

  it("does not recover if lease is valid", async () => {
    const taskId = "TASK-2026-02-13-002";
    const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
    
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
  acquiredAt: ${recentTime}
  expiresAt: ${new Date(new Date(recentTime).getTime() + 10 * 60 * 1000).toISOString()}
  renewCount: 0
metadata: {}
---

Test task body`;

    await writeFile(join(testDir, "tasks", "in-progress", `${taskId}.md`), taskContent);

    const result = await attemptRecovery(store, eventLogger, taskId);
    
    expect(result.recovered).toBe(false);
    expect(result.actions).toHaveLength(0);
    
    // Verify task remains in-progress
    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("in-progress");
  });

  it("logs recovery actions to events.jsonl", async () => {
    const taskId = "TASK-2026-02-13-003";
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

    await attemptRecovery(store, eventLogger, taskId);
    
    // Read events log
    const eventsLog = await readFile(join(testDir, "events", "events.jsonl"), "utf-8");
    const events = eventsLog.trim().split("\n").map(line => JSON.parse(line));
    
    // Find recovery_action event
    const recoveryEvent = events.find(e => e.type === "recovery_action");
    expect(recoveryEvent).toBeDefined();
    expect(recoveryEvent?.taskId).toBe(taskId);
    expect(recoveryEvent?.payload.action).toBe("lease_expired");
  });

  it("formats recovery summary correctly when recovered", () => {
    const result: RecoveryResult = {
      recovered: true,
      actions: [
        {
          type: "lease_expired",
          details: { leaseExpiredAt: "2026-02-13T10:00:00Z", transitionedTo: "ready" },
        },
      ],
    };

    const summary = formatRecoverySummary(result);
    
    expect(summary).toContain("🔧 Recovery triggered:");
    expect(summary).toContain("Lease expired");
    expect(summary).toContain("Task reclaimed to ready");
    expect(summary).toContain("✅ Recovery complete");
  });

  it("formats recovery summary correctly when not recovered", () => {
    const result: RecoveryResult = {
      recovered: false,
      actions: [],
    };

    const summary = formatRecoverySummary(result);
    
    expect(summary).toContain("❌ Recovery could not resolve the issue");
    expect(summary).toContain("Manual intervention required");
  });

  it("recovery does not retry original operation", async () => {
    const taskId = "TASK-2026-02-13-004";
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

    const result = await attemptRecovery(store, eventLogger, taskId);
    
    // Recovery should only check state, not retry anything
    expect(result.recovered).toBe(true);
    expect(result.actions).toHaveLength(1);
    
    // Task should be in ready state (recovered), not closed/completed
    const task = await store.get(taskId);
    expect(task?.frontmatter.status).toBe("ready");
  });

  it("returns actionable error when task not found", async () => {
    const taskId = "TASK-2026-02-13-999";
    
    await expect(
      attemptRecovery(store, eventLogger, taskId)
    ).rejects.toThrow(`Task not found: ${taskId}`);
  });
});
