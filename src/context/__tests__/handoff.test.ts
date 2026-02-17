/**
 * Handoff Notes Tests
 * 
 * Tests for generating, writing, and reading handoff notes that preserve
 * context across compaction and sub-agent boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { generateHandoff, writeHandoff, readHandoff } from "../handoff.js";
import type { HandoffNote } from "../handoff.js";

describe("Handoff Notes", () => {
  let tmpDir: string;
  let store: ITaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-handoff-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("generateHandoff()", () => {
    it("generates minimal handoff note with required fields", () => {
      const note = generateHandoff({
        taskId: "TASK-2026-02-07-001",
        trigger: "manual",
        progress: "Implemented core logic",
      });

      expect(note.taskId).toBe("TASK-2026-02-07-001");
      expect(note.trigger).toBe("manual");
      expect(note.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO 8601
      expect(note.status.progress).toBe("Implemented core logic");
      expect(note.status.current).toBe(""); // defaults to empty
      expect(note.status.blockers).toEqual([]);
      expect(note.status.nextSteps).toEqual([]);
      expect(note.context.keyDecisions).toEqual([]);
      expect(note.context.artifacts).toEqual([]);
      expect(note.context.dependencies).toEqual([]);
    });

    it("generates complete handoff note with all optional fields", () => {
      const note = generateHandoff({
        taskId: "TASK-2026-02-07-002",
        trigger: "compaction",
        progress: "Completed phase 1",
        blockers: ["Waiting for API key"],
        nextSteps: ["Deploy to staging", "Run integration tests"],
        keyDecisions: ["Chose REST over GraphQL for simplicity"],
        artifacts: ["src/api/client.ts", "tests/api.test.ts"],
        dependencies: ["TASK-2026-02-06-001"],
      });

      expect(note.taskId).toBe("TASK-2026-02-07-002");
      expect(note.trigger).toBe("compaction");
      expect(note.status.progress).toBe("Completed phase 1");
      expect(note.status.blockers).toEqual(["Waiting for API key"]);
      expect(note.status.nextSteps).toEqual(["Deploy to staging", "Run integration tests"]);
      expect(note.context.keyDecisions).toEqual(["Chose REST over GraphQL for simplicity"]);
      expect(note.context.artifacts).toEqual(["src/api/client.ts", "tests/api.test.ts"]);
      expect(note.context.dependencies).toEqual(["TASK-2026-02-06-001"]);
    });

    it("accepts all valid trigger types", () => {
      const manual = generateHandoff({
        taskId: "TASK-001",
        trigger: "manual",
        progress: "Test",
      });
      expect(manual.trigger).toBe("manual");

      const compaction = generateHandoff({
        taskId: "TASK-002",
        trigger: "compaction",
        progress: "Test",
      });
      expect(compaction.trigger).toBe("compaction");

      const subAgent = generateHandoff({
        taskId: "TASK-003",
        trigger: "sub-agent-complete",
        progress: "Test",
      });
      expect(subAgent.trigger).toBe("sub-agent-complete");
    });
  });

  describe("writeHandoff()", () => {
    it("writes handoff note to task outputs/handoff.md", async () => {
      const task = await store.create({
        title: "Test Task",
        body: "Test body",
        createdBy: "test",
      });

      const note = generateHandoff({
        taskId: task.frontmatter.id,
        trigger: "manual",
        progress: "Initial implementation complete",
        nextSteps: ["Add tests", "Update docs"],
      });

      await writeHandoff(task.frontmatter.id, note, store);

      // Verify file was written
      const outputs = await store.getTaskOutputs(task.frontmatter.id);
      expect(outputs).toContain("handoff.md");
    });

    it("formats handoff as readable markdown with section headers", async () => {
      const task = await store.create({
        title: "Format Test",
        body: "Body",
        createdBy: "test",
      });

      const note = generateHandoff({
        taskId: task.frontmatter.id,
        trigger: "compaction",
        progress: "Phase 1 done",
        blockers: ["Need review"],
        nextSteps: ["Fix linting"],
        keyDecisions: ["Used TypeScript"],
        artifacts: ["src/main.ts"],
        dependencies: ["TASK-001"],
      });

      await writeHandoff(task.frontmatter.id, note, store);

      // Read the raw markdown file
      const outputs = await store.getTaskOutputs(task.frontmatter.id);
      const handoffPath = join(
        store.tasksDir,
        task.frontmatter.status,
        task.frontmatter.id,
        "outputs",
        "handoff.md"
      );
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(handoffPath, "utf-8");

      // Check for expected section headers
      expect(content).toContain("# Handoff Note");
      expect(content).toContain("## Metadata");
      expect(content).toContain("## Progress");
      expect(content).toContain("## Blockers");
      expect(content).toContain("## Next Steps");
      expect(content).toContain("## Key Decisions");
      expect(content).toContain("## Artifacts");
      expect(content).toContain("## Dependencies");

      // Check content is present
      expect(content).toContain("Phase 1 done");
      expect(content).toContain("Need review");
      expect(content).toContain("Fix linting");
      expect(content).toContain("Used TypeScript");
      expect(content).toContain("src/main.ts");
      expect(content).toContain("TASK-001");

      // Should NOT be raw JSON
      expect(content).not.toContain('"taskId"');
      expect(content).not.toContain('"trigger"');
    });

    it("handles empty optional arrays gracefully", async () => {
      const task = await store.create({
        title: "Minimal Test",
        body: "Body",
        createdBy: "test",
      });

      const note = generateHandoff({
        taskId: task.frontmatter.id,
        trigger: "manual",
        progress: "Done",
      });

      await writeHandoff(task.frontmatter.id, note, store);

      const handoffPath = join(
        store.tasksDir,
        task.frontmatter.status,
        task.frontmatter.id,
        "outputs",
        "handoff.md"
      );
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(handoffPath, "utf-8");

      // Should still have headers but indicate none
      expect(content).toContain("## Blockers");
      expect(content).toContain("None");
      expect(content).toContain("## Next Steps");
      expect(content).toContain("## Key Decisions");
      expect(content).toContain("## Artifacts");
      expect(content).toContain("## Dependencies");
    });

    it("throws error for non-existent task", async () => {
      const note = generateHandoff({
        taskId: "TASK-INVALID",
        trigger: "manual",
        progress: "Test",
      });

      await expect(writeHandoff("TASK-INVALID", note, store)).rejects.toThrow(
        "Task not found"
      );
    });
  });

  describe("readHandoff()", () => {
    it("reads handoff note from task outputs", async () => {
      const task = await store.create({
        title: "Read Test",
        body: "Body",
        createdBy: "test",
      });

      const original = generateHandoff({
        taskId: task.frontmatter.id,
        trigger: "manual",
        progress: "Initial work",
        nextSteps: ["Continue", "Test"],
        keyDecisions: ["Decision 1"],
      });

      await writeHandoff(task.frontmatter.id, original, store);
      const read = await readHandoff(task.frontmatter.id, store);

      expect(read).toBeDefined();
      expect(read!.taskId).toBe(original.taskId);
      expect(read!.trigger).toBe(original.trigger);
      expect(read!.status.progress).toBe(original.status.progress);
      expect(read!.status.nextSteps).toEqual(original.status.nextSteps);
      expect(read!.context.keyDecisions).toEqual(original.context.keyDecisions);
    });

    it("returns null when handoff.md does not exist", async () => {
      const task = await store.create({
        title: "No Handoff",
        body: "Body",
        createdBy: "test",
      });

      const result = await readHandoff(task.frontmatter.id, store);
      expect(result).toBeNull();
    });

    it("throws error for non-existent task", async () => {
      await expect(readHandoff("TASK-INVALID", store)).rejects.toThrow(
        "Task not found"
      );
    });

    it("preserves all fields through write-read round trip", async () => {
      const task = await store.create({
        title: "Round Trip Test",
        body: "Body",
        createdBy: "test",
      });

      const original: HandoffNote = {
        taskId: task.frontmatter.id,
        timestamp: "2026-02-07T19:30:00.000Z",
        trigger: "compaction",
        status: {
          current: "in-progress",
          progress: "Halfway done",
          blockers: ["Blocker A", "Blocker B"],
          nextSteps: ["Step 1", "Step 2", "Step 3"],
        },
        context: {
          keyDecisions: ["Decision X", "Decision Y"],
          artifacts: ["file1.ts", "file2.ts", "file3.ts"],
          dependencies: ["TASK-001", "TASK-002"],
        },
      };

      await writeHandoff(task.frontmatter.id, original, store);
      const read = await readHandoff(task.frontmatter.id, store);

      expect(read).toEqual(original);
    });
  });
});
