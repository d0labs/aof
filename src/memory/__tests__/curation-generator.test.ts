/**
 * Tests for curation task generator.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemTaskStore } from "../../store/task-store.js";
import type { ITaskStore } from "../../store/interfaces.js";
import {
  selectThreshold,
  generateCurationTasks,
  type CurationScope,
} from "../curation-generator.js";
import { CurationPolicy } from "../curation-policy.js";

describe("selectThreshold", () => {
  it("returns most aggressive threshold that entry count exceeds", () => {
    const thresholds = [
      { maxEntries: 100, interval: "30d" },
      { maxEntries: 500, interval: "7d" },
      { maxEntries: 1000, interval: "1d" },
    ];

    // 150 exceeds 100 only
    expect(selectThreshold(150, thresholds)).toEqual({ maxEntries: 100, interval: "30d" });
    // 600 exceeds 100 and 500
    expect(selectThreshold(600, thresholds)).toEqual({ maxEntries: 500, interval: "7d" });
    // 1500 exceeds all
    expect(selectThreshold(1500, thresholds)).toEqual({ maxEntries: 1000, interval: "1d" });
  });

  it("returns null when entry count is below all thresholds", () => {
    const thresholds = [
      { maxEntries: 100, interval: "30d" },
      { maxEntries: 500, interval: "7d" },
    ];

    expect(selectThreshold(50, thresholds)).toBeNull();
    expect(selectThreshold(100, thresholds)).toBeNull();
  });

  it("handles null maxEntries (reserved for future use)", () => {
    const thresholds = [
      { maxEntries: 100, interval: "30d" },
      { maxEntries: 500, interval: "7d" },
      { maxEntries: null, interval: "1d" },
    ];

    expect(selectThreshold(50, thresholds)).toBeNull();
    expect(selectThreshold(150, thresholds)).toEqual({ maxEntries: 100, interval: "30d" });
    expect(selectThreshold(600, thresholds)).toEqual({ maxEntries: 500, interval: "7d" });
    // Null thresholds are currently ignored (use highest numeric threshold)
    expect(selectThreshold(10000, thresholds)).toEqual({ maxEntries: 500, interval: "7d" });
  });

  it("returns null for empty thresholds", () => {
    expect(selectThreshold(1000, [])).toBeNull();
  });
});

describe("generateCurationTasks", () => {
  let testDir: string;
  let projectRoot: string;
  let store: ITaskStore;

  beforeEach(async () => {
    testDir = join(tmpdir(), `aof-test-${Date.now()}`);
    projectRoot = join(testDir, "test-project");
    await mkdir(projectRoot, { recursive: true });
    store = new FilesystemTaskStore(projectRoot);
    await store.init();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const defaultPolicy = CurationPolicy.parse({
    schemaVersion: 1,
    thresholds: [
      { maxEntries: 100, interval: "30d" },
      { maxEntries: 500, interval: "7d" },
      { maxEntries: 1000, interval: "1d" },
    ],
    guardrails: {
      preserveTags: ["important"],
      minEntries: 10,
    },
    strategy: "prune",
  });

  it("creates task when threshold is exceeded", async () => {
    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 600 },
    ];

    const result = await generateCurationTasks(
      store,
      defaultPolicy,
      scopes,
      "filesystem",
      "/policy.yaml"
    );

    expect(result.tasksCreated).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.tasksCreated[0]?.frontmatter.title).toContain("hot");
    expect(result.tasksCreated[0]?.frontmatter.metadata.entryCount).toBe(600);
    // 600 exceeds 100 and 500, so uses 500 threshold
    expect(result.tasksCreated[0]?.frontmatter.metadata.threshold).toEqual({
      maxEntries: 500,
      interval: "7d",
    });
  });

  it("skips when no threshold is exceeded", async () => {
    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 50 },
    ];

    const result = await generateCurationTasks(
      store,
      defaultPolicy,
      scopes,
      "filesystem",
      "/policy.yaml"
    );

    expect(result.tasksCreated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("No threshold exceeded");
  });

  it("skips when curation is disabled for pool", async () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [{ maxEntries: 100, interval: "7d" }],
      poolOverrides: [
        { poolId: "hot", disabled: true },
      ],
    });

    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 500 },
    ];

    const result = await generateCurationTasks(
      store,
      policy,
      scopes,
      "filesystem",
      "/policy.yaml"
    );

    expect(result.tasksCreated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("disabled");
  });

  it("skips when open curation task already exists", async () => {
    // Create existing curation task
    await store.create({
      title: "Curate pool hot",
      body: "Existing task",
      priority: "normal",
      routing: { role: "memory-curator" },
      metadata: {
        type: "curation",
        scopeId: "hot",
      },
      createdBy: "test",
    });

    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 600 },
    ];

    const result = await generateCurationTasks(
      store,
      defaultPolicy,
      scopes,
      "filesystem",
      "/policy.yaml"
    );

    expect(result.tasksCreated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("Open curation task already exists");
  });

  it("skips when interval not met since last done task", async () => {
    // Use a threshold with 1d interval for 1200 entries
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [
        { maxEntries: 100, interval: "30d" },
        { maxEntries: 500, interval: "7d" },
        { maxEntries: 1000, interval: "1d" },
      ],
    });

    // Create a done task that was completed 1 hour ago
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const task = await store.create({
      title: "Curate pool hot",
      body: "Previous task",
      priority: "normal",
      routing: { role: "memory-curator" },
      metadata: {
        type: "curation",
        scopeId: "hot",
      },
      createdBy: "test",
    });

    // Transition through valid states to done
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress", { agent: "test" });
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    // Try to create another task immediately (1d interval not met)
    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 1200 },
    ];

    const result = await generateCurationTasks(
      store,
      policy,
      scopes,
      "filesystem",
      "/policy.yaml",
      { now: new Date() }
    );

    expect(result.tasksCreated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("Interval not met");
  });

  it("creates task when interval has passed", async () => {
    // Create task with 7d interval threshold (500 max entries)
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [
        { maxEntries: 100, interval: "30d" },
        { maxEntries: 500, interval: "7d" },
      ],
    });

    // Create a done task
    const task = await store.create({
      title: "Curate pool hot",
      body: "Previous task",
      priority: "normal",
      routing: { role: "memory-curator" },
      metadata: {
        type: "curation",
        scopeId: "hot",
      },
      createdBy: "test",
    });

    // Transition to done
    await store.transition(task.frontmatter.id, "ready");
    await store.transition(task.frontmatter.id, "in-progress", { agent: "test" });
    await store.transition(task.frontmatter.id, "review");
    await store.transition(task.frontmatter.id, "done");

    // Simulate checking 8 days later
    const eightDaysLater = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 600 },
    ];

    const result = await generateCurationTasks(
      store,
      policy,
      scopes,
      "filesystem",
      "/policy.yaml",
      { now: eightDaysLater }
    );

    expect(result.tasksCreated).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("respects dry-run mode", async () => {
    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 600 },
    ];

    const result = await generateCurationTasks(
      store,
      defaultPolicy,
      scopes,
      "filesystem",
      "/policy.yaml",
      { dryRun: true }
    );

    expect(result.tasksCreated).toHaveLength(1);
    expect(result.tasksCreated[0]?.frontmatter.id).toBe("DRY-RUN");

    // Verify no actual task was created
    const allTasks = await store.list();
    expect(allTasks).toHaveLength(0);
  });

  it("applies pool-specific thresholds", async () => {
    const policy = CurationPolicy.parse({
      schemaVersion: 1,
      thresholds: [
        { maxEntries: 1000, interval: "7d" },
      ],
      poolOverrides: [
        {
          poolId: "hot",
          thresholds: [
            { maxEntries: 100, interval: "1d" },
          ],
        },
      ],
    });

    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 150 },
    ];

    const result = await generateCurationTasks(
      store,
      policy,
      scopes,
      "filesystem",
      "/policy.yaml"
    );

    expect(result.tasksCreated).toHaveLength(1);
    expect(result.tasksCreated[0]?.frontmatter.metadata.threshold).toEqual({
      maxEntries: 100,
      interval: "1d",
    });
  });

  it("includes guardrails in task metadata", async () => {
    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 600 },
    ];

    const result = await generateCurationTasks(
      store,
      defaultPolicy,
      scopes,
      "filesystem",
      "/policy.yaml"
    );

    expect(result.tasksCreated).toHaveLength(1);
    const guardrails = result.tasksCreated[0]?.frontmatter.metadata.guardrails as any;
    expect(guardrails.preserveTags).toEqual(["important"]);
    expect(guardrails.minEntries).toBe(10);
  });

  it("transitions created tasks to ready", async () => {
    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 600 },
    ];

    const result = await generateCurationTasks(
      store,
      defaultPolicy,
      scopes,
      "filesystem",
      "/policy.yaml"
    );

    expect(result.tasksCreated).toHaveLength(1);
    expect(result.tasksCreated[0]?.frontmatter.status).toBe("ready");
  });

  it("handles multiple scopes independently", async () => {
    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 600 },
      { type: "pool", id: "warm", entryCount: 50 },
      { type: "pool", id: "archive", entryCount: 1200 },
    ];

    const result = await generateCurationTasks(
      store,
      defaultPolicy,
      scopes,
      "filesystem",
      "/policy.yaml"
    );

    expect(result.tasksCreated).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.scope.id).toBe("warm");
  });

  it("includes backend and policy path in metadata", async () => {
    const scopes: CurationScope[] = [
      { type: "pool", id: "hot", entryCount: 600 },
    ];

    const result = await generateCurationTasks(
      store,
      defaultPolicy,
      scopes,
      "memory-lancedb",
      "/path/to/policy.yaml"
    );

    expect(result.tasksCreated).toHaveLength(1);
    expect(result.tasksCreated[0]?.frontmatter.metadata.backend).toBe("memory-lancedb");
    expect(result.tasksCreated[0]?.frontmatter.metadata.policyPath).toBe("/path/to/policy.yaml");
  });
});
