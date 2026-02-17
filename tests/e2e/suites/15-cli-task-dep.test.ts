/**
 * E2E Test: CLI task dep commands
 * 
 * Tests CLI commands for managing task dependencies:
 * - aof task dep add <task-id> <blocker-id>
 * - aof task dep remove <task-id> <blocker-id>
 * 
 * Tests both happy paths and error cases:
 * - Add dependency (happy path)
 * - Remove dependency (happy path)
 * - Circular dependency rejection
 * - Self-dependency rejection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FilesystemTaskStore } from "../../../src/store/task-store.js";
import type { ITaskStore } from "../../../src/store/interfaces.js";
import { taskDepAdd, taskDepRemove } from "../../../src/cli/commands/task-dep.js";
import { seedTestData, cleanupTestData } from "../utils/test-data.js";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_DATA_DIR = join(homedir(), ".openclaw-aof-e2e-test", "aof-test-cli-dep");

describe("E2E: CLI task dep commands", () => {
  let store: ITaskStore;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    await seedTestData(TEST_DATA_DIR);
    store = new FilesystemTaskStore(TEST_DATA_DIR);
    await store.init();

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    // Reset exitCode
    process.exitCode = 0;
  });

  afterEach(async () => {
    await cleanupTestData(TEST_DATA_DIR);
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
  });

  describe("taskDepAdd", () => {
    it("should add a dependency between two tasks (happy path)", async () => {
      // Create two tasks
      const task1 = await store.create({
        title: "Task 1",
        body: "This task will depend on task 2",
        createdBy: "test-system",
      });
      const task2 = await store.create({
        title: "Task 2",
        body: "This is the blocker task",
        createdBy: "test-system",
      });

      // Add dependency
      await taskDepAdd(store, task1.frontmatter.id, task2.frontmatter.id);

      // Verify dependency was added
      const updated = await store.get(task1.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toContain(task2.frontmatter.id);

      // Verify success message
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Added dependency")
      );
      expect(process.exitCode).toBe(0);
    });

    it("should be idempotent (no error if dependency already exists)", async () => {
      // Create two tasks with an existing dependency
      const task1 = await store.create({
        title: "Task 1",
        createdBy: "test-system",
      });
      const task2 = await store.create({
        title: "Task 2",
        createdBy: "test-system",
      });
      await store.addDep(task1.frontmatter.id, task2.frontmatter.id);

      // Add the same dependency again
      await taskDepAdd(store, task1.frontmatter.id, task2.frontmatter.id);

      // Should succeed (idempotent)
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Added dependency")
      );
      expect(process.exitCode).toBe(0);

      // Verify dependency still exists (only once)
      const updated = await store.get(task1.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toHaveLength(1);
      expect(updated?.frontmatter.dependsOn).toContain(task2.frontmatter.id);
    });

    it("should reject self-dependency", async () => {
      const task = await store.create({
        title: "Self-referencing task",
        createdBy: "test-system",
      });

      await taskDepAdd(store, task.frontmatter.id, task.frontmatter.id);

      // Verify error message
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("cannot depend on itself")
      );
      expect(process.exitCode).toBe(1);

      // Verify dependency was not added
      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toHaveLength(0);
    });

    it("should reject circular dependency", async () => {
      // Create two tasks
      const task1 = await store.create({
        title: "Task 1",
        createdBy: "test-system",
      });
      const task2 = await store.create({
        title: "Task 2",
        createdBy: "test-system",
      });

      // Add dependency: task1 depends on task2
      await store.addDep(task1.frontmatter.id, task2.frontmatter.id);

      // Try to add reverse dependency: task2 depends on task1 (would create cycle)
      await taskDepAdd(store, task2.frontmatter.id, task1.frontmatter.id);

      // Verify error message
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("circular dependency")
      );
      expect(process.exitCode).toBe(1);

      // Verify reverse dependency was not added
      const updated = await store.get(task2.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).not.toContain(task1.frontmatter.id);
    });

    it("should reject adding dependency when task not found", async () => {
      const task = await store.create({
        title: "Valid task",
        createdBy: "test-system",
      });

      await taskDepAdd(store, "NONEXISTENT-TASK", task.frontmatter.id);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Task not found")
      );
      expect(process.exitCode).toBe(1);
    });

    it("should reject adding dependency when blocker not found", async () => {
      const task = await store.create({
        title: "Valid task",
        createdBy: "test-system",
      });

      await taskDepAdd(store, task.frontmatter.id, "NONEXISTENT-BLOCKER");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Blocker task not found")
      );
      expect(process.exitCode).toBe(1);
    });

    it("should reject adding dependency to task in terminal state", async () => {
      const task1 = await store.create({
        title: "Done task",
        createdBy: "test-system",
      });
      const task2 = await store.create({
        title: "Blocker task",
        createdBy: "test-system",
      });

      // Transition task1 to done
      await store.transition(task1.frontmatter.id, "ready");
      await store.transition(task1.frontmatter.id, "in-progress");
      await store.transition(task1.frontmatter.id, "review");
      await store.transition(task1.frontmatter.id, "done");

      await taskDepAdd(store, task1.frontmatter.id, task2.frontmatter.id);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("terminal state")
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe("taskDepRemove", () => {
    it("should remove a dependency from a task (happy path)", async () => {
      // Create two tasks with a dependency
      const task1 = await store.create({
        title: "Task 1",
        createdBy: "test-system",
      });
      const task2 = await store.create({
        title: "Task 2",
        createdBy: "test-system",
      });
      await store.addDep(task1.frontmatter.id, task2.frontmatter.id);

      // Verify dependency exists
      let updated = await store.get(task1.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toContain(task2.frontmatter.id);

      // Remove dependency
      await taskDepRemove(store, task1.frontmatter.id, task2.frontmatter.id);

      // Verify dependency was removed
      updated = await store.get(task1.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).not.toContain(task2.frontmatter.id);

      // Verify success message
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Removed dependency")
      );
      expect(process.exitCode).toBe(0);
    });

    it("should support removing multiple dependencies one by one", async () => {
      const mainTask = await store.create({
        title: "Main task",
        createdBy: "test-system",
      });
      const blocker1 = await store.create({
        title: "Blocker 1",
        createdBy: "test-system",
      });
      const blocker2 = await store.create({
        title: "Blocker 2",
        createdBy: "test-system",
      });

      // Add two dependencies
      await store.addDep(mainTask.frontmatter.id, blocker1.frontmatter.id);
      await store.addDep(mainTask.frontmatter.id, blocker2.frontmatter.id);

      let updated = await store.get(mainTask.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toHaveLength(2);

      // Remove one dependency
      await taskDepRemove(store, mainTask.frontmatter.id, blocker1.frontmatter.id);

      updated = await store.get(mainTask.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toHaveLength(1);
      expect(updated?.frontmatter.dependsOn).toContain(blocker2.frontmatter.id);
      expect(process.exitCode).toBe(0);
    });

    it("should be idempotent (no error if dependency doesn't exist)", async () => {
      const task1 = await store.create({
        title: "Task 1",
        createdBy: "test-system",
      });
      const task2 = await store.create({
        title: "Task 2",
        createdBy: "test-system",
      });

      // Remove dependency that doesn't exist
      await taskDepRemove(store, task1.frontmatter.id, task2.frontmatter.id);

      // Should succeed (idempotent)
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Removed dependency")
      );
      expect(process.exitCode).toBe(0);
    });

    it("should reject removing dependency when task not found", async () => {
      const task = await store.create({
        title: "Valid task",
        createdBy: "test-system",
      });

      await taskDepRemove(store, "NONEXISTENT-TASK", task.frontmatter.id);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Task not found")
      );
      expect(process.exitCode).toBe(1);
    });

    it("should handle removing dependency when blocker doesn't exist", async () => {
      const task = await store.create({
        title: "Valid task",
        createdBy: "test-system",
      });

      // This should succeed (idempotent) even though blocker doesn't exist
      await taskDepRemove(store, task.frontmatter.id, "NONEXISTENT-BLOCKER");

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Removed dependency")
      );
      expect(process.exitCode).toBe(0);
    });

    it("should reject removing dependency from task in terminal state", async () => {
      const task1 = await store.create({
        title: "Done task",
        createdBy: "test-system",
      });
      const task2 = await store.create({
        title: "Blocker task",
        createdBy: "test-system",
      });

      // Add dependency first
      await store.addDep(task1.frontmatter.id, task2.frontmatter.id);

      // Transition task1 to done
      await store.transition(task1.frontmatter.id, "ready");
      await store.transition(task1.frontmatter.id, "in-progress");
      await store.transition(task1.frontmatter.id, "review");
      await store.transition(task1.frontmatter.id, "done");

      await taskDepRemove(store, task1.frontmatter.id, task2.frontmatter.id);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("terminal state")
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe("dependency workflow integration", () => {
    it("should support adding and removing multiple dependencies", async () => {
      const mainTask = await store.create({
        title: "Main task",
        createdBy: "test-system",
      });
      const blocker1 = await store.create({
        title: "Blocker 1",
        createdBy: "test-system",
      });
      const blocker2 = await store.create({
        title: "Blocker 2",
        createdBy: "test-system",
      });

      // Add two dependencies
      await taskDepAdd(store, mainTask.frontmatter.id, blocker1.frontmatter.id);
      await taskDepAdd(store, mainTask.frontmatter.id, blocker2.frontmatter.id);

      let updated = await store.get(mainTask.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toHaveLength(2);
      expect(updated?.frontmatter.dependsOn).toContain(blocker1.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toContain(blocker2.frontmatter.id);

      // Remove one dependency
      await taskDepRemove(store, mainTask.frontmatter.id, blocker1.frontmatter.id);

      updated = await store.get(mainTask.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toHaveLength(1);
      expect(updated?.frontmatter.dependsOn).toContain(blocker2.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).not.toContain(blocker1.frontmatter.id);

      // Remove second dependency
      await taskDepRemove(store, mainTask.frontmatter.id, blocker2.frontmatter.id);

      updated = await store.get(mainTask.frontmatter.id);
      expect(updated?.frontmatter.dependsOn).toHaveLength(0);
    });
  });
});
