/**
 * BUG-001 Regression Tests: TaskStore hydration from existing disk files
 * 
 * Tests that TaskStore correctly discovers and indexes existing task files
 * during initialization, not just new files created through the API.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore, serializeTask } from "../task-store.js";
import type { ITaskStore } from "../interfaces.js";
import type { Task } from "../../schemas/task.js";

describe("BUG-001: TaskStore hydration from disk", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-bug001-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers existing task file in backlog/ on initialization", async () => {
    // Create a valid task file BEFORE initializing TaskStore
    const backlogDir = join(tmpDir, "tasks", "backlog");
    await mkdir(backlogDir, { recursive: true });

    const task: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-08-001",
        project: "AOF",
        title: "Pre-existing task",
        status: "backlog",
        priority: "normal",
        routing: { tags: [] },
        createdAt: "2026-02-08T19:00:00Z",
        updatedAt: "2026-02-08T19:00:00Z",
        lastTransitionAt: "2026-02-08T19:00:00Z",
        createdBy: "system",
        dependsOn: [],
        metadata: {},
        contentHash: "abc123",
      },
      body: "This task existed before TaskStore was initialized.",
    };

    const filePath = join(backlogDir, "TASK-2026-02-08-001.md");
    await writeFile(filePath, serializeTask(task));

    // NOW initialize TaskStore — should discover the file
    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    // Verify task is visible via list()
    const tasks = await store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.frontmatter.id).toBe("TASK-2026-02-08-001");
    expect(tasks[0]?.frontmatter.title).toBe("Pre-existing task");
  });

  it("discovers tasks across multiple status directories", async () => {
    // Create tasks in different status directories
    const tasksDir = join(tmpDir, "tasks");
    await mkdir(join(tasksDir, "backlog"), { recursive: true });
    await mkdir(join(tasksDir, "ready"), { recursive: true });
    await mkdir(join(tasksDir, "done"), { recursive: true });

    const createTask = (id: string, status: "backlog" | "ready" | "done") => ({
      frontmatter: {
        schemaVersion: 1,
        id,
        project: "AOF",
        title: `Task ${id}`,
        status,
        priority: "normal" as const,
        routing: { tags: [] },
        createdAt: "2026-02-08T19:00:00Z",
        updatedAt: "2026-02-08T19:00:00Z",
        lastTransitionAt: "2026-02-08T19:00:00Z",
        createdBy: "system",
        dependsOn: [],
        metadata: {},
        contentHash: "abc",
      },
      body: "Test body",
    });

    await writeFile(
      join(tasksDir, "backlog", "TASK-2026-02-08-001.md"),
      serializeTask(createTask("TASK-2026-02-08-001", "backlog")),
    );
    await writeFile(
      join(tasksDir, "ready", "TASK-2026-02-08-002.md"),
      serializeTask(createTask("TASK-2026-02-08-002", "ready")),
    );
    await writeFile(
      join(tasksDir, "done", "TASK-2026-02-08-003.md"),
      serializeTask(createTask("TASK-2026-02-08-003", "done")),
    );

    // Initialize and verify all 3 tasks are discovered
    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const allTasks = await store.list();
    expect(allTasks).toHaveLength(3);

    const backlog = await store.list({ status: "backlog" });
    expect(backlog).toHaveLength(1);
    expect(backlog[0]?.frontmatter.id).toBe("TASK-2026-02-08-001");

    const ready = await store.list({ status: "ready" });
    expect(ready).toHaveLength(1);

    const done = await store.list({ status: "done" });
    expect(done).toHaveLength(1);
  });

  it("skips malformed task files with logged error (not silent failure)", async () => {
    const backlogDir = join(tmpDir, "tasks", "backlog");
    await mkdir(backlogDir, { recursive: true });

    // Write an invalid task file (missing required fields)
    const invalidFile = join(backlogDir, "invalid-task.md");
    await writeFile(invalidFile, "---\ntitle: Invalid\n---\nNo required fields");

    // Write a valid task file
    const validTask: Task = {
      frontmatter: {
        schemaVersion: 1,
        id: "TASK-2026-02-08-999",
        project: "AOF",
        title: "Valid task",
        status: "backlog",
        priority: "normal",
        routing: { tags: [] },
        createdAt: "2026-02-08T19:00:00Z",
        updatedAt: "2026-02-08T19:00:00Z",
        lastTransitionAt: "2026-02-08T19:00:00Z",
        createdBy: "system",
        dependsOn: [],
        metadata: {},
        contentHash: "xyz",
      },
      body: "Valid body",
    };
    await writeFile(
      join(backlogDir, "TASK-2026-02-08-999.md"),
      serializeTask(validTask),
    );

    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    // Should load only the valid task
    const tasks = await store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.frontmatter.id).toBe("TASK-2026-02-08-999");
    
    // Invalid file should be reported via lint()
    const issues = await store.lint();
    const parseErrors = issues.filter(i => i.issue.includes("Parse error"));
    expect(parseErrors.length).toBeGreaterThan(0);
  });

  it("returns accurate stats after hydration", async () => {
    const tasksDir = join(tmpDir, "tasks");
    await mkdir(join(tasksDir, "backlog"), { recursive: true });
    await mkdir(join(tasksDir, "ready"), { recursive: true });

    const createTask = (id: string, status: "backlog" | "ready") => ({
      frontmatter: {
        schemaVersion: 1,
        id,
        project: "AOF",
        title: `Task ${id}`,
        status,
        priority: "normal" as const,
        routing: { tags: [] },
        createdAt: "2026-02-08T19:00:00Z",
        updatedAt: "2026-02-08T19:00:00Z",
        lastTransitionAt: "2026-02-08T19:00:00Z",
        createdBy: "system",
        dependsOn: [],
        metadata: {},
        contentHash: "abc",
      },
      body: "Test",
    });

    // 2 backlog, 1 ready
    await writeFile(
      join(tasksDir, "backlog", "TASK-2026-02-08-001.md"),
      serializeTask(createTask("TASK-2026-02-08-001", "backlog")),
    );
    await writeFile(
      join(tasksDir, "backlog", "TASK-2026-02-08-002.md"),
      serializeTask(createTask("TASK-2026-02-08-002", "backlog")),
    );
    await writeFile(
      join(tasksDir, "ready", "TASK-2026-02-08-003.md"),
      serializeTask(createTask("TASK-2026-02-08-003", "ready")),
    );

    store = new FilesystemTaskStore(tmpDir);
    await store.init();

    const allTasks = await store.list();
    expect(allTasks).toHaveLength(3);

    const backlog = await store.list({ status: "backlog" });
    expect(backlog).toHaveLength(2);

    const ready = await store.list({ status: "ready" });
    expect(ready).toHaveLength(1);
  });
});
