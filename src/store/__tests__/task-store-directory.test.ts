/**
 * TaskStore Directory Support Tests
 * 
 * Tests directory-based task cards alongside flat file support:
 * tasks/<status>/TASK-ID/
 * ├── TASK-ID.md
 * ├── inputs/
 * └── outputs/
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore, serializeTask } from "../task-store.js";
import type { ITaskStore } from "../interfaces.js";
import type { Task } from "../../schemas/task.js";

describe("TaskStore Directory Support", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-taskstore-dir-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("getTaskInputs()", () => {
    it("returns empty array when no inputs directory exists", async () => {
      const task = await store.create({
        title: "Task without inputs",
        createdBy: "test",
      });

      const inputs = await store.getTaskInputs(task.frontmatter.id);
      expect(inputs).toEqual([]);
    });

    it("lists all files in inputs directory", async () => {
      const task = await store.create({
        title: "Task with inputs",
        createdBy: "test",
      });

      // Write files to inputs/
      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "brief.md"), "# Project Brief\n\nContext here", "utf-8");
      await writeFile(join(inputsDir, "specs.md"), "# Specifications\n\nSpecs here", "utf-8");
      await writeFile(join(inputsDir, "data.json"), '{"key": "value"}', "utf-8");

      const inputs = await store.getTaskInputs(task.frontmatter.id);
      
      expect(inputs).toHaveLength(3);
      expect(inputs).toContain("brief.md");
      expect(inputs).toContain("specs.md");
      expect(inputs).toContain("data.json");
    });

    it("throws error when task does not exist", async () => {
      await expect(store.getTaskInputs("TASK-2024-01-01-999")).rejects.toThrow("Task not found");
    });
  });

  describe("getTaskOutputs()", () => {
    it("returns empty array when no outputs directory exists", async () => {
      const task = await store.create({
        title: "Task without outputs",
        createdBy: "test",
      });

      const outputs = await store.getTaskOutputs(task.frontmatter.id);
      expect(outputs).toEqual([]);
    });

    it("lists all files in outputs directory", async () => {
      const task = await store.create({
        title: "Task with outputs",
        createdBy: "test",
      });

      // Write files to outputs/
      const outputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "outputs");
      await mkdir(outputsDir, { recursive: true });
      await writeFile(join(outputsDir, "result.md"), "# Result\n\nImplementation complete", "utf-8");
      await writeFile(join(outputsDir, "data.json"), '{"status": "success"}', "utf-8");

      const outputs = await store.getTaskOutputs(task.frontmatter.id);
      
      expect(outputs).toHaveLength(2);
      expect(outputs).toContain("result.md");
      expect(outputs).toContain("data.json");
    });

    it("throws error when task does not exist", async () => {
      await expect(store.getTaskOutputs("TASK-2024-01-01-999")).rejects.toThrow("Task not found");
    });
  });

  describe("writeTaskOutput()", () => {
    it("writes a file to the outputs directory", async () => {
      const task = await store.create({
        title: "Task for output",
        createdBy: "test",
      });

      await store.writeTaskOutput(task.frontmatter.id, "summary.md", "# Summary\n\nAll done!");

      // Verify file was written
      const outputPath = join(
        tmpDir,
        "tasks",
        "backlog",
        task.frontmatter.id,
        "outputs",
        "summary.md"
      );
      const content = await readFile(outputPath, "utf-8");
      expect(content).toBe("# Summary\n\nAll done!");
    });

    it("overwrites existing output file", async () => {
      const task = await store.create({
        title: "Task for overwrite",
        createdBy: "test",
      });

      await store.writeTaskOutput(task.frontmatter.id, "log.txt", "First version");
      await store.writeTaskOutput(task.frontmatter.id, "log.txt", "Second version");

      const outputPath = join(
        tmpDir,
        "tasks",
        "backlog",
        task.frontmatter.id,
        "outputs",
        "log.txt"
      );
      const content = await readFile(outputPath, "utf-8");
      expect(content).toBe("Second version");
    });

    it("creates outputs directory if it doesn't exist", async () => {
      const task = await store.create({
        title: "Task for auto-create",
        createdBy: "test",
      });

      // Remove outputs directory
      const outputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "outputs");
      await rm(outputsDir, { recursive: true, force: true });

      await store.writeTaskOutput(task.frontmatter.id, "file.txt", "Content");

      const outputPath = join(outputsDir, "file.txt");
      const content = await readFile(outputPath, "utf-8");
      expect(content).toBe("Content");
    });

    it("throws error when task does not exist", async () => {
      await expect(
        store.writeTaskOutput("TASK-2024-01-01-999", "file.txt", "content")
      ).rejects.toThrow("Task not found");
    });
  });

  describe("Directory-based task transitions", () => {
    it("moves entire task directory when transitioning status", async () => {
      const task = await store.create({
        title: "Task with directory",
        createdBy: "test",
      });

      // Add inputs and outputs
      await store.writeTaskOutput(task.frontmatter.id, "output.txt", "output content");
      const inputsDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id, "inputs");
      await mkdir(inputsDir, { recursive: true });
      await writeFile(join(inputsDir, "input.txt"), "input content", "utf-8");

      // Transition to ready
      await store.transition(task.frontmatter.id, "ready");

      // Verify task and directories moved
      const backlogDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id);
      const readyDir = join(tmpDir, "tasks", "ready", task.frontmatter.id);

      // Old location should not exist
      await expect(readdir(backlogDir)).rejects.toThrow();

      // New location should exist with all content
      const readyFiles = await readdir(readyDir);
      expect(readyFiles).toContain("inputs");
      expect(readyFiles).toContain("outputs");

      const inputFiles = await readdir(join(readyDir, "inputs"));
      expect(inputFiles).toContain("input.txt");

      const outputFiles = await readdir(join(readyDir, "outputs"));
      expect(outputFiles).toContain("output.txt");
    });

    it("handles transition when task has no companion directory", async () => {
      const task = await store.create({
        title: "Flat file task",
        createdBy: "test",
      });

      // Remove companion directory
      const taskDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id);
      await rm(taskDir, { recursive: true, force: true });

      // Transition should still work
      await expect(store.transition(task.frontmatter.id, "ready")).resolves.not.toThrow();

      const updated = await store.get(task.frontmatter.id);
      expect(updated?.frontmatter.status).toBe("ready");
    });
  });

  describe("Backward compatibility with flat files", () => {
    it("reads flat file task when directory does not exist", async () => {
      const task = await store.create({
        title: "Flat file task",
        createdBy: "test",
      });

      // Remove companion directory to simulate old-style flat file
      const taskDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id);
      await rm(taskDir, { recursive: true, force: true });

      // Should still be able to read the task
      const retrieved = await store.get(task.frontmatter.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.frontmatter.id).toBe(task.frontmatter.id);
      expect(retrieved?.frontmatter.title).toBe("Flat file task");
    });

    it("getTaskInputs returns empty for flat file task", async () => {
      const task = await store.create({
        title: "Flat file task",
        createdBy: "test",
      });

      // Remove companion directory
      const taskDir = join(tmpDir, "tasks", "backlog", task.frontmatter.id);
      await rm(taskDir, { recursive: true, force: true });

      const inputs = await store.getTaskInputs(task.frontmatter.id);
      expect(inputs).toEqual([]);
    });
  });
});
