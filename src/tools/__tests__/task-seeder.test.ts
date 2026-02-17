/**
 * Task Seeder Tests — BUG-002 Regression
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import { EventLogger } from "../../events/logger.js";
import {
  seedTasks,
  seedTasksFromFile,
  createMinimalSeedPack,
  type TaskSeedEntry,
} from "../task-seeder.js";

describe("Task Seeder", () => {
  let tmpDir: string;
  let store: ITaskStore;
  let logger: EventLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "seeder-test-"));
    store = new FilesystemTaskStore(tmpDir);
    await store.init();
    logger = new EventLogger(join(tmpDir, "events"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("seedTasks (programmatic)", () => {
    it("seeds multiple tasks from array", async () => {
      const seeds: TaskSeedEntry[] = [
        {
          title: "Task 1",
          brief: "First task",
          agent: "test-agent",
        },
        {
          title: "Task 2",
          brief: "Second task",
          priority: "high",
        },
      ];

      const result = await seedTasks(seeds, store, logger, {
        actor: "test-seeder",
      });

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.taskIds).toHaveLength(2);

      // Verify tasks exist on disk
      const tasks = await store.list();
      expect(tasks).toHaveLength(2);
    });

    it("handles seeding errors gracefully", async () => {
      const seeds: TaskSeedEntry[] = [
        {
          title: "Valid task",
          brief: "Good task",
        },
        {
          title: "", // Invalid: empty title
          brief: "Bad task",
        },
        {
          title: "Another valid task",
          brief: "Good task 2",
        },
      ];

      const result = await seedTasks(seeds, store, logger);

      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error).toContain("title");
    });

    it("supports dry run mode", async () => {
      const seeds: TaskSeedEntry[] = [
        { title: "Task 1", brief: "Test" },
        { title: "Task 2", brief: "Test" },
      ];

      const result = await seedTasks(seeds, store, logger, {
        dryRun: true,
      });

      expect(result.succeeded).toBe(2);
      expect(result.taskIds).toHaveLength(0);

      // Verify no tasks created
      const tasks = await store.list();
      expect(tasks).toHaveLength(0);
    });

    it("seeds tasks with all optional fields", async () => {
      const seeds: TaskSeedEntry[] = [
        {
          title: "Full task",
          brief: "Complete spec",
          description: "Detailed description",
          agent: "swe-backend",
          team: "engineering",
          role: "developer",
          priority: "high",
          tags: ["bug", "p0"],
          metadata: { projectId: "proj-001" },
        },
      ];

      const result = await seedTasks(seeds, store, logger);

      expect(result.succeeded).toBe(1);

      const task = await store.get(result.taskIds[0]!);
      expect(task).toBeDefined();
      expect(task!.frontmatter.priority).toBe("high");
      expect(task!.frontmatter.routing.agent).toBe("swe-backend");
      expect(task!.frontmatter.routing.team).toBe("engineering");
      expect(task!.frontmatter.metadata?.tags).toContain("bug");
    });
  });

  describe("seedTasksFromFile", () => {
    it("seeds tasks from YAML file", async () => {
      const seedFile = join(tmpDir, "seeds.yaml");
      const yamlContent = `
version: 1
seeds:
  - title: "YAML Task 1"
    brief: "First task from YAML"
    agent: "test-agent"
  - title: "YAML Task 2"
    brief: "Second task from YAML"
    priority: "high"
`;
      await writeFile(seedFile, yamlContent, "utf-8");

      const result = await seedTasksFromFile(seedFile, store, logger);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);

      const tasks = await store.list();
      expect(tasks).toHaveLength(2);
      expect(tasks.map(t => t.frontmatter.title)).toContain("YAML Task 1");
    });

    it("seeds tasks from JSON file", async () => {
      const seedFile = join(tmpDir, "seeds.json");
      const jsonContent = {
        version: 1,
        seeds: [
          {
            title: "JSON Task 1",
            brief: "First JSON task",
          },
          {
            title: "JSON Task 2",
            brief: "Second JSON task",
            priority: "low",
          },
        ],
      };
      await writeFile(seedFile, JSON.stringify(jsonContent, null, 2), "utf-8");

      const result = await seedTasksFromFile(seedFile, store, logger);

      expect(result.succeeded).toBe(2);

      const tasks = await store.list();
      expect(tasks.map(t => t.frontmatter.title)).toContain("JSON Task 1");
    });

    it("throws error on invalid seed file structure", async () => {
      const seedFile = join(tmpDir, "invalid.yaml");
      await writeFile(seedFile, "invalid: structure", "utf-8");

      await expect(
        seedTasksFromFile(seedFile, store, logger)
      ).rejects.toThrow(/missing 'seeds' array/i);
    });

    it("handles file read errors", async () => {
      await expect(
        seedTasksFromFile("/nonexistent/file.yaml", store, logger)
      ).rejects.toThrow();
    });

    it("supports dry run from file", async () => {
      const seedFile = join(tmpDir, "seeds.yaml");
      const yamlContent = `
version: 1
seeds:
  - title: "Dry run task"
    brief: "Should not be created"
`;
      await writeFile(seedFile, yamlContent, "utf-8");

      const result = await seedTasksFromFile(seedFile, store, logger, {
        dryRun: true,
      });

      expect(result.succeeded).toBe(1);

      const tasks = await store.list();
      expect(tasks).toHaveLength(0);
    });
  });

  describe("createMinimalSeedPack", () => {
    it("returns a valid seed file structure", () => {
      const seedPack = createMinimalSeedPack();

      expect(seedPack.version).toBe(1);
      expect(seedPack.seeds).toBeDefined();
      expect(seedPack.seeds.length).toBeGreaterThan(0);
      expect(seedPack.seeds[0]).toHaveProperty("title");
      expect(seedPack.seeds[0]).toHaveProperty("brief");
    });

    it("creates seeded tasks successfully", async () => {
      const seedPack = createMinimalSeedPack();
      const result = await seedTasks(seedPack.seeds, store, logger);

      expect(result.succeeded).toBe(seedPack.seeds.length);
      expect(result.failed).toBe(0);

      const tasks = await store.list();
      expect(tasks).toHaveLength(seedPack.seeds.length);
    });

    it("includes expected task fields", () => {
      const seedPack = createMinimalSeedPack();

      for (const seed of seedPack.seeds) {
        expect(seed.title).toBeTruthy();
        expect(seed.brief).toBeTruthy();
        expect(seed.priority).toBeDefined();
      }
    });
  });

  describe("BUG-002 Acceptance Criteria", () => {
    it("seeding produces task files in correct directories", async () => {
      const seeds: TaskSeedEntry[] = [
        { title: "Test 1", brief: "Brief 1" },
        { title: "Test 2", brief: "Brief 2" },
      ];

      const result = await seedTasks(seeds, store, logger);

      // All seeded tasks should be in 'ready' status
      const readyDir = join(tmpDir, "tasks", "ready");
      const entries = await readdir(readyDir);
      
      // Filter for .md files only (each task has both .md file and directory)
      const mdFiles = entries.filter(e => e.endsWith(".md"));
      expect(mdFiles).toHaveLength(2);

      // Verify task.md files exist
      for (const taskId of result.taskIds) {
        const taskFile = join(readyDir, `${taskId}.md`);
        await expect(readFile(taskFile, "utf-8")).resolves.toBeTruthy();
      }
    });

    it("aof_status_report returns total > 0 after seeding", async () => {
      const seeds = createMinimalSeedPack().seeds;
      await seedTasks(seeds, store, logger);

      const tasks = await store.list();
      expect(tasks.length).toBeGreaterThan(0);
    });

    it("find command returns seeded task files", async () => {
      await seedTasks(
        [{ title: "Findable task", brief: "Should be found" }],
        store,
        logger
      );

      // Simulate: find ~/.openclaw/aof/tasks -name '*.md'
      const allTasks = await store.list();
      const taskFiles = allTasks.map(t => t.path).filter(p => p?.endsWith(".md"));

      expect(taskFiles.length).toBeGreaterThan(0);
    });
  });

  describe("Edge cases", () => {
    it("handles empty seeds array", async () => {
      const result = await seedTasks([], store, logger);

      expect(result.total).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("handles large batch of seeds", async () => {
      const seeds: TaskSeedEntry[] = Array.from({ length: 50 }, (_, i) => ({
        title: `Task ${i + 1}`,
        brief: `Brief for task ${i + 1}`,
      }));

      const result = await seedTasks(seeds, store, logger);

      expect(result.succeeded).toBe(50);
      expect(result.failed).toBe(0);

      const tasks = await store.list();
      expect(tasks).toHaveLength(50);
    });

    it("preserves seed order", async () => {
      const seeds: TaskSeedEntry[] = [
        { title: "Alpha", brief: "First" },
        { title: "Beta", brief: "Second" },
        { title: "Gamma", brief: "Third" },
      ];

      const result = await seedTasks(seeds, store, logger);

      const tasks = await Promise.all(
        result.taskIds.map(id => store.get(id))
      );
      const titles = tasks.map(t => t?.frontmatter.title);

      expect(titles[0]).toBe("Alpha");
      expect(titles[1]).toBe("Beta");
      expect(titles[2]).toBe("Gamma");
    });
  });
});
