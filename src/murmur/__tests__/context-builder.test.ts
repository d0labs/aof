/**
 * Tests for murmur context builder — assembles orchestration review context.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildReviewContext } from "../context-builder.js";
import type { OrgTeam } from "../../schemas/org-chart.js";
import type { MurmurState } from "../state-manager.js";
import type { ITaskStore } from "../../store/interfaces.js";
import type { Task } from "../../schemas/task.js";

describe("buildReviewContext", () => {
  const testDocsDir = ".test-docs";
  let mockStore: ITaskStore;
  let mockTeam: OrgTeam;
  let mockState: MurmurState;

  beforeEach(async () => {
    // Clean up test directory
    await rm(testDocsDir, { recursive: true, force: true });
    await mkdir(testDocsDir, { recursive: true });

    // Create mock task store
    mockStore = createMockStore();

    // Default team config
    mockTeam = {
      id: "test-team",
      name: "Test Team",
      description: "Test team for context builder",
      murmur: {
        triggers: [
          {
            kind: "completionBatch",
            threshold: 5,
          },
        ],
        context: [],
      },
    };

    // Default murmur state
    mockState = {
      teamId: "test-team",
      lastReviewAt: "2026-02-17T10:00:00.000Z",
      completionsSinceLastReview: 5,
      failuresSinceLastReview: 2,
      currentReviewTaskId: "TASK-2026-02-17-001",
      lastTriggeredBy: "completionBatch",
    };
  });

  afterEach(async () => {
    await rm(testDocsDir, { recursive: true, force: true });
  });

  it("should build context with all sections when configured", async () => {
    // Setup: create vision and roadmap docs
    await mkdir(join(testDocsDir, "docs"), { recursive: true });
    await writeFile(
      join(testDocsDir, "docs", "vision.md"),
      "# Vision\n\nBuild the best AOF orchestration system."
    );
    await writeFile(
      join(testDocsDir, "docs", "roadmap.md"),
      "# Roadmap\n\nQ1: Launch MVP\nQ2: Scale"
    );

    // Add tasks to store
    mockStore.list = vi.fn().mockResolvedValue([
      createMockTask("TASK-2026-02-17-001", "done", "Implement feature A"),
      createMockTask("TASK-2026-02-17-002", "done", "Fix bug B"),
      createMockTask("TASK-2026-02-17-003", "in-progress", "Add tests"),
      createMockTask("TASK-2026-02-17-004", "deadletter", "Deploy failed"),
    ]);
    mockStore.countByStatus = vi.fn().mockResolvedValue({
      done: 2,
      "in-progress": 1,
      deadletter: 1,
    });

    mockTeam.murmur!.context = ["vision", "roadmap", "taskSummary"];

    const context = await buildReviewContext(mockTeam, mockState, mockStore, {
      docsBasePath: testDocsDir,
    });

    // Verify all sections present
    expect(context).toContain("# Orchestration Review");
    expect(context).toContain("**Team:** Test Team");
    expect(context).toContain(
      "**Trigger:** Completion batch threshold — 5 tasks completed"
    );
    expect(context).toContain("## Vision");
    expect(context).toContain("Build the best AOF orchestration system");
    expect(context).toContain("## Roadmap");
    expect(context).toContain("Q1: Launch MVP");
    expect(context).toContain("## Task Summary");
    expect(context).toContain("### Current Task Counts");
    expect(context).toContain("- **done**: 2");
    expect(context).toContain("- **in-progress**: 1");
    expect(context).toContain("- **deadletter**: 1");
    expect(context).toContain("### Activity Since Last Review");
    expect(context).toContain("- **Completed**: 5 tasks");
    expect(context).toContain("- **Failed**: 2 tasks");
    expect(context).toContain("### Recently Completed Tasks");
    expect(context).toContain("- **TASK-2026-02-17-001**: Implement feature A");
    expect(context).toContain("### Failed/Stuck Tasks Requiring Attention");
    expect(context).toContain(
      "- **TASK-2026-02-17-004** (deadletter): Deploy failed"
    );
    expect(context).toContain("## Instructions");
    expect(context).toContain(
      "Review the above. Create new tasks, adjust existing ones, or report status using the aof_task_* tools."
    );
  });

  it("should only include taskSummary when context array is empty", async () => {
    // Setup: no context sections configured
    mockTeam.murmur!.context = [];

    mockStore.list = vi.fn().mockResolvedValue([
      createMockTask("TASK-2026-02-17-001", "ready", "Task A"),
    ]);
    mockStore.countByStatus = vi.fn().mockResolvedValue({
      ready: 1,
    });

    const context = await buildReviewContext(mockTeam, mockState, mockStore, {
      docsBasePath: testDocsDir,
    });

    // Verify only header, taskSummary, and instructions present
    expect(context).toContain("# Orchestration Review");
    expect(context).toContain("## Task Summary");
    expect(context).toContain("### Current Task Counts");
    expect(context).toContain("- **ready**: 1");
    expect(context).toContain("## Instructions");

    // Verify vision and roadmap NOT present
    expect(context).not.toContain("## Vision");
    expect(context).not.toContain("## Roadmap");
  });

  it("should handle missing vision file gracefully", async () => {
    // Setup: request vision but file doesn't exist
    mockTeam.murmur!.context = ["vision", "taskSummary"];

    const logger = {
      warn: vi.fn(),
    };

    mockStore.list = vi.fn().mockResolvedValue([]);
    mockStore.countByStatus = vi.fn().mockResolvedValue({});

    const context = await buildReviewContext(mockTeam, mockState, mockStore, {
      docsBasePath: testDocsDir,
      logger,
    });

    // Verify warning logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load vision doc"),
      expect.objectContaining({
        path: expect.stringContaining("vision.md"),
      })
    );

    // Verify vision section not in output
    expect(context).not.toContain("## Vision");

    // Verify other sections still present
    expect(context).toContain("## Task Summary");
    expect(context).toContain("## Instructions");
  });

  it("should handle missing roadmap file gracefully", async () => {
    // Setup: request roadmap but file doesn't exist
    mockTeam.murmur!.context = ["roadmap", "taskSummary"];

    const logger = {
      warn: vi.fn(),
    };

    mockStore.list = vi.fn().mockResolvedValue([]);
    mockStore.countByStatus = vi.fn().mockResolvedValue({});

    const context = await buildReviewContext(mockTeam, mockState, mockStore, {
      docsBasePath: testDocsDir,
      logger,
    });

    // Verify warning logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load roadmap doc"),
      expect.objectContaining({
        path: expect.stringContaining("roadmap.md"),
      })
    );

    // Verify roadmap section not in output
    expect(context).not.toContain("## Roadmap");

    // Verify other sections still present
    expect(context).toContain("## Task Summary");
  });

  it("should include trigger reason in header", async () => {
    mockStore.list = vi.fn().mockResolvedValue([]);
    mockStore.countByStatus = vi.fn().mockResolvedValue({});

    // Test different trigger types
    const testCases: Array<{
      trigger: string | null;
      expected: string;
    }> = [
      {
        trigger: "queueEmpty",
        expected: "**Trigger:** Queue empty — no ready tasks remaining",
      },
      {
        trigger: "completionBatch",
        expected: "**Trigger:** Completion batch threshold — 5 tasks completed",
      },
      {
        trigger: "failureBatch",
        expected: "**Trigger:** Failure batch threshold — 2 tasks failed",
      },
      {
        trigger: "interval",
        expected: "**Trigger:** Scheduled interval trigger",
      },
      {
        trigger: null,
        expected: "**Trigger:** Manual trigger",
      },
    ];

    for (const { trigger, expected } of testCases) {
      const state = { ...mockState, lastTriggeredBy: trigger };
      const context = await buildReviewContext(mockTeam, state, mockStore);
      expect(context).toContain(expected);
    }
  });

  it("should handle empty task list", async () => {
    mockStore.list = vi.fn().mockResolvedValue([]);
    mockStore.countByStatus = vi.fn().mockResolvedValue({});

    const context = await buildReviewContext(mockTeam, mockState, mockStore);

    // Verify structure present even with no tasks
    expect(context).toContain("## Task Summary");
    expect(context).toContain("### Current Task Counts");
    expect(context).toContain("### Activity Since Last Review");

    // Verify no task lists shown (only counts/activity)
    expect(context).not.toContain("### Recently Completed Tasks");
    expect(context).not.toContain("### Failed/Stuck Tasks Requiring Attention");
  });

  it("should show blocked tasks in failed/stuck section", async () => {
    mockStore.list = vi.fn().mockResolvedValue([
      createMockTask("TASK-2026-02-17-001", "blocked", "Waiting on API"),
      createMockTask("TASK-2026-02-17-002", "deadletter", "Failed to deploy"),
    ]);
    mockStore.countByStatus = vi.fn().mockResolvedValue({
      blocked: 1,
      deadletter: 1,
    });

    const context = await buildReviewContext(mockTeam, mockState, mockStore);

    expect(context).toContain("### Failed/Stuck Tasks Requiring Attention");
    expect(context).toContain("- **TASK-2026-02-17-001** (blocked): Waiting on API");
    expect(context).toContain(
      "- **TASK-2026-02-17-002** (deadletter): Failed to deploy"
    );

    // Verify deadletter comes before blocked (more critical)
    const deadletterIdx = context.indexOf("TASK-2026-02-17-002");
    const blockedIdx = context.indexOf("TASK-2026-02-17-001");
    expect(deadletterIdx).toBeLessThan(blockedIdx);
  });

  it("should respect maxRecentTasks limit", async () => {
    // Create 15 completed tasks
    const tasks: Task[] = [];
    for (let i = 1; i <= 15; i++) {
      tasks.push(
        createMockTask(
          `TASK-2026-02-17-${String(i).padStart(3, "0")}`,
          "done",
          `Task ${i}`
        )
      );
    }

    mockStore.list = vi.fn().mockResolvedValue(tasks);
    mockStore.countByStatus = vi.fn().mockResolvedValue({ done: 15 });

    const context = await buildReviewContext(mockTeam, mockState, mockStore, {
      maxRecentTasks: 5,
    });

    // Count how many tasks appear in recently completed
    const completedSection = context.split("### Recently Completed Tasks")[1];
    const taskCount = (completedSection?.match(/- \*\*TASK-/g) || []).length;

    expect(taskCount).toBe(5);
  });

  it("should respect maxFailedTasks limit", async () => {
    // Create 15 deadletter tasks
    const tasks: Task[] = [];
    for (let i = 1; i <= 15; i++) {
      tasks.push(
        createMockTask(
          `TASK-2026-02-17-${String(i).padStart(3, "0")}`,
          "deadletter",
          `Failed task ${i}`
        )
      );
    }

    mockStore.list = vi.fn().mockResolvedValue(tasks);
    mockStore.countByStatus = vi.fn().mockResolvedValue({ deadletter: 15 });

    const context = await buildReviewContext(mockTeam, mockState, mockStore, {
      maxFailedTasks: 3,
    });

    // Count how many tasks appear in failed/stuck section
    const failedSection = context.split(
      "### Failed/Stuck Tasks Requiring Attention"
    )[1];
    const taskCount = (failedSection?.match(/- \*\*TASK-/g) || []).length;

    expect(taskCount).toBe(3);
  });
});

// Helper functions

function createMockStore(): ITaskStore {
  return {
    projectRoot: ".test-docs",
    projectId: "TEST",
    tasksDir: ".test-docs/tasks",
    init: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    get: vi.fn(),
    getByPrefix: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    countByStatus: vi.fn().mockResolvedValue({}),
    transition: vi.fn(),
    cancel: vi.fn(),
    updateBody: vi.fn(),
    update: vi.fn(),
    touch: vi.fn(),
    computeReadyTasks: vi.fn(),
    acquireLease: vi.fn(),
    renewLease: vi.fn(),
    releaseLease: vi.fn(),
    getDependents: vi.fn(),
    isStale: vi.fn(),
  } as unknown as ITaskStore;
}

function createMockTask(
  id: string,
  status: string,
  title: string
): Task {
  return {
    frontmatter: {
      schemaVersion: 1,
      id,
      project: "TEST",
      title,
      status: status as any,
      priority: "normal",
      routing: {},
      createdAt: "2026-02-17T09:00:00.000Z",
      updatedAt: "2026-02-17T10:00:00.000Z",
      lastTransitionAt: "2026-02-17T10:00:00.000Z",
      createdBy: "system",
      dependsOn: [],
      metadata: {},
      gateHistory: [],
      tests: [],
    },
    body: "Task body content",
  };
}
