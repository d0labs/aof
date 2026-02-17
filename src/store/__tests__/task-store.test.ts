import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore, parseTaskFile, serializeTask } from "../task-store.js";
import type { ITaskStore } from "../interfaces.js";

describe("parseTaskFile / serializeTask", () => {
  const raw = `---
schemaVersion: 1
id: "TASK-2026-02-06-001"
project: "AOF"
title: Test Task
status: backlog
priority: normal
routing:
  tags: []
createdAt: "2026-02-06T19:00:00Z"
updatedAt: "2026-02-06T19:00:00Z"
lastTransitionAt: "2026-02-06T19:00:00Z"
createdBy: main
dependsOn: []
metadata: {}
---

## Instructions

Do the thing.

See also: ./artifacts/design.md
`;

  it("round-trips through parse → serialize → parse", () => {
    const task = parseTaskFile(raw);
    const serialized = serializeTask(task);
    const reparsed = parseTaskFile(serialized);

    expect(reparsed.frontmatter.id).toBe(task.frontmatter.id);
    expect(reparsed.frontmatter.title).toBe(task.frontmatter.title);
    expect(reparsed.body).toContain("Do the thing.");
    expect(reparsed.body).toContain("./artifacts/design.md");
  });

  it("throws on missing frontmatter fence", () => {
    expect(() => parseTaskFile("no frontmatter")).toThrow("must start with");
  });

  it("throws on unterminated frontmatter", () => {
    expect(() => parseTaskFile("---\nfoo: bar\n")).toThrow("Unterminated");
  });
});

describe("TaskStore", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates and retrieves a task", async () => {
    const task = await store.create({
      title: "Test task",
      body: "Do something",
      createdBy: "main",
    });

    expect(task.frontmatter.id).toBeDefined();
    expect(task.frontmatter.status).toBe("backlog");

    const loaded = await store.get(task.frontmatter.id);
    expect(loaded).toBeDefined();
    expect(loaded!.frontmatter.title).toBe("Test task");
    expect(loaded!.body).toBe("Do something");
  });

  it("generates TASK-YYYY-MM-DD-NNN ids", async () => {
    const task1 = await store.create({ title: "Task 1", createdBy: "main" });
    const task2 = await store.create({ title: "Task 2", createdBy: "main" });
    const today = new Date().toISOString().slice(0, 10);
    const regex = new RegExp(`^TASK-${today}-\\d{3}$`);

    expect(task1.frontmatter.id).toMatch(regex);
    expect(task2.frontmatter.id).toMatch(regex);

    const num1 = parseInt(task1.frontmatter.id.slice(-3), 10);
    const num2 = parseInt(task2.frontmatter.id.slice(-3), 10);
    expect(num2).toBe(num1 + 1);
  });

  it("creates companion directories for task artifacts", async () => {
    const task = await store.create({ title: "Dirs test", createdBy: "main" });
    const { stat } = await import("node:fs/promises");
    const baseDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id);

    await expect(stat(baseDir)).resolves.toBeDefined();
    await expect(stat(join(baseDir, "inputs"))).resolves.toBeDefined();
    await expect(stat(join(baseDir, "work"))).resolves.toBeDefined();
    await expect(stat(join(baseDir, "outputs"))).resolves.toBeDefined();
  });

  it("moves companion directories on status transition", async () => {
    const task = await store.create({ title: "Move dirs", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    const { stat } = await import("node:fs/promises");
    const oldDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id);
    const newDir = join(tmpDir, "tasks", "ready", task.frontmatter.id);

    await expect(stat(newDir)).resolves.toBeDefined();
    await expect(stat(oldDir)).rejects.toThrow();
  });

  it("transitions atomically (file always exists in one location)", async () => {
    const task = await store.create({ title: "Atomic test", createdBy: "main" });
    await store.transition(task.frontmatter.id, "ready");
    
    // After transition, task must exist in exactly one location
    const loaded = await store.get(task.frontmatter.id);
    expect(loaded).toBeDefined();
    expect(loaded!.frontmatter.status).toBe("ready");
  });

  it("lists tasks with filters", async () => {
    await store.create({ title: "Task A", createdBy: "main" });
    await store.create({ title: "Task B", createdBy: "main", priority: "high" });

    const all = await store.list();
    expect(all).toHaveLength(2);

    const backlog = await store.list({ status: "backlog" });
    expect(backlog).toHaveLength(2);

    const ready = await store.list({ status: "ready" });
    expect(ready).toHaveLength(0);
  });

  it("transitions task with validation", async () => {
    const task = await store.create({ title: "Transition test", createdBy: "main" });
    const id = task.frontmatter.id;

    // Valid: backlog → ready
    const ready = await store.transition(id, "ready");
    expect(ready.frontmatter.status).toBe("ready");

    // Valid: ready → in-progress
    const inProgress = await store.transition(id, "in-progress");
    expect(inProgress.frontmatter.status).toBe("in-progress");

    // Invalid: in-progress → backlog
    await expect(store.transition(id, "backlog")).rejects.toThrow("Invalid transition");
  });

  it("makes transition idempotent (no error on same status)", async () => {
    const task = await store.create({ title: "Idempotent test", createdBy: "main" });
    const id = task.frontmatter.id;

    // Transition to ready
    await store.transition(id, "ready");

    // Transition to ready again (should be no-op, no error)
    const result = await store.transition(id, "ready");
    expect(result.frontmatter.status).toBe("ready");

    // Verify task is still accessible
    const loaded = await store.get(id);
    expect(loaded?.frontmatter.status).toBe("ready");
  });

  it("updates body and recalculates hash", async () => {
    const task = await store.create({ title: "Hash test", body: "v1", createdBy: "main" });
    const hash1 = task.frontmatter.contentHash;

    const updated = await store.updateBody(task.frontmatter.id, "v2 content");
    expect(updated.frontmatter.contentHash).not.toBe(hash1);
    expect(updated.body).toBe("v2 content");
  });

  it("persists metadata on create", async () => {
    const task = await store.create({
      title: "Metadata test",
      createdBy: "main",
      metadata: { project: "AOF", phase: "P3" },
    });

    const loaded = await store.get(task.frontmatter.id);
    expect(loaded?.frontmatter.metadata).toMatchObject({
      project: "AOF",
      phase: "P3",
    });
  });

  it("deletes a task", async () => {
    const task = await store.create({ title: "Delete me", createdBy: "main" });
    expect(await store.delete(task.frontmatter.id)).toBe(true);
    expect(await store.get(task.frontmatter.id)).toBeUndefined();
  });

  it("returns undefined for nonexistent task", async () => {
    expect(await store.get("TASK-2026-02-06-999")).toBeUndefined();
  });

  it("gets task by ID prefix", async () => {
    const task = await store.create({ title: "Prefix test", createdBy: "main" });
    const prefix = task.frontmatter.id.slice(0, 8);
    const found = await store.getByPrefix(prefix);
    expect(found).toBeDefined();
    expect(found!.frontmatter.id).toBe(task.frontmatter.id);
  });

  it("preserves pointer paths in task body", async () => {
    const body = `## Artifacts

- Design doc: ./artifacts/design.md
- API spec: ../shared/api-spec.yaml
- Test data: /absolute/path/to/fixtures.json`;

    const task = await store.create({ title: "Pointer test", body, createdBy: "main" });
    const loaded = await store.get(task.frontmatter.id);
    expect(loaded!.body).toContain("./artifacts/design.md");
    expect(loaded!.body).toContain("../shared/api-spec.yaml");
  });

  describe("BUG-001: Task Parse Validation", () => {
    it("emits validation.failed event when task has invalid frontmatter", async () => {
      const { writeFile } = await import("node:fs/promises");
      const { EventLogger } = await import("../../events/logger.js");
      const eventsDir = join(tmpDir, "events");
      const logger = new EventLogger(eventsDir);

      // Create a malformed task file with legacy schema (missing required fields)
      const malformedFile = join(tmpDir, "tasks", "backlog", "test-legacy.md");
      const malformedContent = `---
id: test-legacy
project: AOF
title: Legacy Schema Task
status: backlog
created: 2026-02-08T15:00:00Z
updated: 2026-02-08T15:00:00Z
tags:
  - test
  - legacy
---
Task body with legacy schema`;

      await writeFile(malformedFile, malformedContent, "utf-8");

      // Create store with event logger
      const storeWithLogger = new FilesystemTaskStore(tmpDir, { logger });

      // List tasks should log validation failure
      const tasks = await storeWithLogger.list();

      // Task should be excluded from list
      expect(tasks.length).toBe(0);

      // Should emit validation.failed event
      const { readFile, readdir } = await import("node:fs/promises");
      const files = await readdir(eventsDir);
      expect(files.length).toBeGreaterThan(0);

      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const validationEvent = events.find((e: any) => e.type === "task.validation.failed");

      expect(validationEvent).toBeDefined();
      expect(validationEvent.payload.filename).toContain("test-legacy.md");
      expect(validationEvent.payload.errors).toBeDefined();
    });

    it("tracks unparseable task count", async () => {
      const { writeFile } = await import("node:fs/promises");
      const { EventLogger } = await import("../../events/logger.js");
      const eventsDir = join(tmpDir, "events");
      const logger = new EventLogger(eventsDir);

      // Create a valid task
      const validTask = await store.create({ title: "Valid task", createdBy: "main" });

      // Create 2 malformed task files (missing required fields)
      const malformed1 = join(tmpDir, "tasks", "backlog", "malformed-1.md");
      const malformed2 = join(tmpDir, "tasks", "ready", "malformed-2.md");

      await writeFile(malformed1, `---
id: malformed-1
project: AOF
title: Bad Task 1
status: backlog
created: 2026-02-08T15:00:00Z
---
Body`, "utf-8");

      await writeFile(malformed2, `---
id: malformed-2
project: AOF
title: Bad Task 2
status: ready
updated: 2026-02-08T15:00:00Z
---
Body`, "utf-8");

      // Create store with logger
      const storeWithLogger = new FilesystemTaskStore(tmpDir, { logger });

      // List should return only valid task
      const tasks = await storeWithLogger.list();
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.frontmatter.id).toBe(validTask.frontmatter.id);

      // Check for 2 validation.failed events
      const { readFile, readdir } = await import("node:fs/promises");
      const files = await readdir(eventsDir);
      const content = await readFile(join(eventsDir, files[0]!), "utf-8");
      const events = content.trim().split("\n").map(line => JSON.parse(line));
      const validationEvents = events.filter((e: any) => e.type === "task.validation.failed");

      expect(validationEvents.length).toBe(2);
    });

    it("logs warning to console when task parsing fails", async () => {
      const { writeFile } = await import("node:fs/promises");
      
      // Create malformed task (missing required fields)
      const malformedFile = join(tmpDir, "tasks", "backlog", "console-test.md");
      await writeFile(malformedFile, `---
id: console-test
project: AOF
status: backlog
---
Missing required fields`, "utf-8");

      // Capture console.error
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: any[]) => {
        errors.push(args.join(" "));
      };

      try {
        await store.list();

        // Should have logged error
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some(e => e.includes("console-test.md"))).toBe(true);
        expect(errors.some(e => e.includes("Parse error"))).toBe(true);
      } finally {
        console.error = originalError;
      }
    });
  });
});
