/**
 * Tests for task edit command.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemTaskStore } from "../../../store/task-store.js";
import type { ITaskStore } from "../../../store/interfaces.js";
import { EventLogger } from "../../../events/logger.js";
import { taskEdit } from "../task-edit.js";

describe("Task Edit Command", () => {
  let testDir: string;
  let store: ITaskStore;
  let eventLogger: EventLogger;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "aof-task-edit-test-"));
    
    await mkdir(join(testDir, "tasks", "backlog"), { recursive: true });
    await mkdir(join(testDir, "tasks", "ready"), { recursive: true });
    await mkdir(join(testDir, "tasks", "done"), { recursive: true });
    await mkdir(join(testDir, "events"), { recursive: true });
    
    eventLogger = new EventLogger(join(testDir, "events"));
    store = new FilesystemTaskStore(testDir, { projectId: "test", logger: eventLogger });
    await store.init();
    
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    // Reset exit code after each test
    process.exitCode = 0;
  });

  it("successfully edits task title", async () => {
    const task = await store.create({
      title: "Original Title",
      body: "Original body",
      createdBy: "test",
    });

    await taskEdit(store, task.frontmatter.id, {
      title: "Updated Title",
    });

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.title).toBe("Updated Title");
    expect(updated?.body).toBe("Original body");
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("✅ Task updated"));
  });

  it("successfully edits multiple fields", async () => {
    const task = await store.create({
      title: "Original Title",
      body: "Original body",
      priority: "normal",
      createdBy: "test",
    });

    await taskEdit(store, task.frontmatter.id, {
      title: "New Title",
      priority: "high",
      assignee: "swe-backend",
      team: "core",
    });

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.title).toBe("New Title");
    expect(updated?.frontmatter.priority).toBe("high");
    expect(updated?.frontmatter.routing.agent).toBe("swe-backend");
    expect(updated?.frontmatter.routing.team).toBe("core");
  });

  it("fails with friendly error for missing task", async () => {
    await taskEdit(store, "TASK-9999-99-99-999", { title: "New Title" });
    
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("❌ Task not found"));
    expect(process.exitCode).toBe(1);
  });

  it("fails with friendly error for terminal state", async () => {
    const task = await store.create({
      title: "Test Task",
      createdBy: "test",
    });

    // Transition to done
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress");
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    await taskEdit(store, task.frontmatter.id, { title: "New Title" });
    
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("❌ Cannot edit task in terminal state"));
    expect(process.exitCode).toBe(1);
  });

  it("successfully edits description", async () => {
    const task = await store.create({
      title: "Test Task",
      body: "Original body",
      createdBy: "test",
    });

    await taskEdit(store, task.frontmatter.id, {
      description: "Updated body content",
    });

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.body).toBe("Updated body content");
  });

  it("successfully edits priority", async () => {
    const task = await store.create({
      title: "Test Task",
      priority: "normal",
      createdBy: "test",
    });

    await taskEdit(store, task.frontmatter.id, {
      priority: "critical",
    });

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.priority).toBe("critical");
  });

  it("successfully edits assignee (routing.agent)", async () => {
    const task = await store.create({
      title: "Test Task",
      createdBy: "test",
    });

    await taskEdit(store, task.frontmatter.id, {
      assignee: "swe-frontend",
    });

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.routing.agent).toBe("swe-frontend");
  });

  it("successfully edits team", async () => {
    const task = await store.create({
      title: "Test Task",
      createdBy: "test",
    });

    await taskEdit(store, task.frontmatter.id, {
      team: "platform",
    });

    const updated = await store.get(task.frontmatter.id);
    expect(updated?.frontmatter.routing.team).toBe("platform");
  });
});
