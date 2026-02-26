/**
 * Multi-project polling tests for TASK-069.
 *
 * Validates that AOFService can discover and poll multiple projects,
 * aggregate stats, and inject project context into TaskContext.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { AOFService } from "../aof-service.js";
import type { GatewayAdapter, TaskContext, SpawnResult } from "../../dispatch/executor.js";
import { FilesystemTaskStore } from "../../store/task-store.js";

class TestExecutor implements GatewayAdapter {
  readonly spawned: TaskContext[] = [];

  async spawnSession(context: TaskContext): Promise<SpawnResult> {
    this.spawned.push(context);
    return {
      success: true,
      sessionId: `session-${context.taskId}`,
    };
  }

  async getSessionStatus(sessionId: string) {
    return { sessionId, alive: false };
  }

  async forceCompleteSession(_sessionId: string) {}

  clear(): void {
    this.spawned.length = 0;
  }
}

describe("Multi-project polling (TASK-069)", () => {
  let tmpDir: string;
  let vaultRoot: string;
  let executor: TestExecutor;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-multiproj-"));
    vaultRoot = tmpDir;
    executor = new TestExecutor();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createProject(
    projectId: string,
    opts: { title?: string; status?: string } = {}
  ): Promise<string> {
    const projectPath = join(vaultRoot, "Projects", projectId);
    await mkdir(projectPath, { recursive: true });

    const manifest = {
      id: projectId,
      title: opts.title ?? projectId,
      status: opts.status ?? "active",
      type: "swe",
      owner: { team: "engineering", lead: "test" },
      participants: [],
      routing: { intake: { default: "Tasks/Backlog" }, mailboxes: { enabled: false } },
      memory: {
        tiers: { bronze: "cold", silver: "warm", gold: "warm" },
        allowIndex: { warmPaths: [] },
        denyIndex: [],
      },
      links: { dashboards: [], docs: [] },
    };

    await writeFile(
      join(projectPath, "project.yaml"),
      stringifyYaml(manifest),
      "utf-8"
    );

    // Create task directories
    const tasksDir = join(projectPath, "tasks");
    await mkdir(join(tasksDir, "backlog"), { recursive: true });
    await mkdir(join(tasksDir, "ready"), { recursive: true });
    await mkdir(join(tasksDir, "in-progress"), { recursive: true });
    await mkdir(join(tasksDir, "done"), { recursive: true });

    return projectPath;
  }

  async function createTask(
    projectPath: string,
    taskId: string,
    opts: { status?: string; agent?: string; projectId?: string } = {}
  ): Promise<void> {
    const status = opts.status ?? "ready";
    const taskPath = join(projectPath, "tasks", status, `${taskId}.md`);
    const now = new Date().toISOString();

    // Extract project ID from path if not provided
    const projectId = opts.projectId ?? projectPath.split("/").pop()!;

    const frontmatter = {
      schemaVersion: 1,
      id: taskId,
      project: projectId,
      title: `Task ${taskId}`,
      status,
      priority: "normal",
      createdAt: now,
      updatedAt: now,
      lastTransitionAt: now,
      createdBy: "test-system",
      routing: opts.agent ? { agent: opts.agent, tags: [] } : { tags: [] },
    };

    const content = `---
${stringifyYaml(frontmatter)}---

## Instructions
Test task for multi-project polling.
`;

    await writeFile(taskPath, content, "utf-8");
  }

  it("discovers and polls multiple projects", async () => {
    // Create two projects with tasks
    const proj1 = await createProject("project-alpha");
    const proj2 = await createProject("project-beta");

    await createTask(proj1, "TASK-2026-02-12-001", { agent: "swe-backend" });
    await createTask(proj2, "TASK-2026-02-12-002", { agent: "swe-qa" });

    const service = new AOFService(
      { executor },
      {
        dataDir: join(tmpDir, "data"),
        vaultRoot,
        dryRun: false,
        pollIntervalMs: 60_000,
      }
    );

    await service.start();

    // Wait for first poll
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = service.getStatus();
    expect(status.lastPollResult).toBeDefined();
    
    // After dispatch, tasks are in-progress
    expect(status.lastPollResult!.stats.total).toBe(2);
    expect(status.lastPollResult!.stats.inProgress).toBe(2);

    // Verify both tasks were spawned
    expect(executor.spawned).toHaveLength(2);
    expect(executor.spawned.map((c) => c.taskId).sort()).toEqual([
      "TASK-2026-02-12-001",
      "TASK-2026-02-12-002",
    ]);

    await service.stop();
  });

  it("injects project context into TaskContext", async () => {
    const proj1 = await createProject("project-gamma");
    await createTask(proj1, "TASK-2026-02-12-003", { agent: "swe-backend" });

    const service = new AOFService(
      { executor },
      {
        dataDir: join(tmpDir, "data"),
        vaultRoot,
        dryRun: false,
      }
    );

    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(executor.spawned).toHaveLength(1);
    const context = executor.spawned[0]!;

    // Verify project fields are present
    expect(context.projectId).toBe("project-gamma");
    expect(context.projectRoot).toBe(proj1);
    expect(context.taskRelpath).toBe("tasks/in-progress/TASK-2026-02-12-003.md");

    await service.stop();
  });

  it("skips projects with invalid manifests", async () => {
    const proj1 = await createProject("project-valid");
    await createTask(proj1, "TASK-2026-02-12-004", { agent: "swe-backend" });

    // Create invalid project (missing manifest)
    const invalidPath = join(vaultRoot, "Projects", "project-invalid");
    await mkdir(invalidPath, { recursive: true });

    const service = new AOFService(
      { executor },
      {
        dataDir: join(tmpDir, "data"),
        vaultRoot,
        dryRun: false,
      }
    );

    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Only valid project's task should be spawned
    expect(executor.spawned).toHaveLength(1);
    expect(executor.spawned[0]!.projectId).toBe("project-valid");

    await service.stop();
  });

  it("aggregates stats across projects", async () => {
    const proj1 = await createProject("project-stats-1");
    const proj2 = await createProject("project-stats-2");

    // Project 1: 2 ready, 1 in-progress (will be reclaimed to ready by FOUND-03 reconciliation)
    await createTask(proj1, "TASK-2026-02-12-005", { agent: "swe-backend" });
    await createTask(proj1, "TASK-2026-02-12-006", { agent: "swe-qa" });
    await createTask(proj1, "TASK-2026-02-12-007", { status: "in-progress" });

    // Project 2: 1 ready, 1 done
    await createTask(proj2, "TASK-2026-02-12-008", { agent: "swe-backend" });
    await createTask(proj2, "TASK-2026-02-12-009", { status: "done" });

    const service = new AOFService(
      { executor },
      {
        dataDir: join(tmpDir, "data"),
        vaultRoot,
        dryRun: false,
      }
    );

    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = service.getStatus();
    expect(status.lastPollResult).toBeDefined();

    const stats = status.lastPollResult!.stats;
    expect(stats.total).toBe(5);
    // After FOUND-03 reconciliation, the 1 in-progress task is reclaimed to ready (4 ready total).
    // Dispatch is limited by maxConcurrentDispatches (default 3), so 3 become in-progress.
    expect(stats.inProgress).toBe(3);
    expect(stats.done).toBe(1);

    await service.stop();
  });

  it("falls back to single-store mode when vaultRoot not provided", async () => {
    const dataDir = join(tmpDir, "single-store-data");
    const store = new FilesystemTaskStore(dataDir, { projectId: "single-store-data" });
    await store.init();

    await createTask(dataDir, "TASK-2026-02-12-010", {
      agent: "swe-backend",
      projectId: "single-store-data",
    });

    const service = new AOFService(
      { executor, store },
      {
        dataDir,
        dryRun: false,
      }
    );

    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(executor.spawned).toHaveLength(1);
    expect(executor.spawned[0]!.taskId).toBe("TASK-2026-02-12-010");

    await service.stop();
  });

  it("includes _inbox as placeholder project", async () => {
    // Create one normal project, _inbox should be auto-created
    await createProject("project-delta");

    const service = new AOFService(
      { executor },
      {
        dataDir: join(tmpDir, "data"),
        vaultRoot,
        dryRun: true,
      }
    );

    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Can't directly verify _inbox store creation, but service should start without errors
    expect(service.getStatus().running).toBe(true);

    await service.stop();
  });
});
