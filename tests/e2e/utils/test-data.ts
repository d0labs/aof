/**
 * Test data seeding and cleanup utilities.
 */

import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface TaskFixture {
  id: string;
  title: string;
  status: "backlog" | "ready" | "in-progress" | "review" | "done" | "blocked";
  assignedTo?: string;
  priority?: "critical" | "high" | "normal" | "low";
  tags?: string[];
  body?: string;
}

/**
 * Create task markdown from fixture data.
 */
export function createTaskMarkdown(fixture: TaskFixture): string {
  const frontmatter = {
    id: fixture.id,
    title: fixture.title,
    status: fixture.status,
    priority: fixture.priority ?? "P2",
    assignedTo: fixture.assignedTo,
    tags: fixture.tags ?? [],
    created: new Date().toISOString(),
  };

  const lines = [
    "---",
    ...Object.entries(frontmatter)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return `${key}: [${value.join(", ")}]`;
        }
        return `${key}: ${value}`;
      }),
    "---",
    "",
    `# ${fixture.title}`,
    "",
    fixture.body ?? "Task body goes here.",
    "",
  ];

  return lines.join("\n");
}

/**
 * Create minimal org chart YAML for tests.
 */
export function createTestOrgChart(agents: string[]): string {
  const lines = [
    "version: '1.0'",
    "agents:",
    ...agents.map((agent) => `  ${agent}:`),
    ...agents.map(() => `    role: test-agent`),
    "roles:",
    "  test-agent:",
    "    description: Test agent for E2E tests",
    "    capabilities:",
    "      - task-execution",
    "",
  ];

  return lines.join("\n");
}

/**
 * Seed test data directory with fixtures.
 */
export async function seedTestData(
  dataDir: string,
  fixtures?: TaskFixture[]
): Promise<void> {
  // Create directory structure (match TaskStatus enum)
  await mkdir(join(dataDir, "tasks", "backlog"), { recursive: true });
  await mkdir(join(dataDir, "tasks", "ready"), { recursive: true });
  await mkdir(join(dataDir, "tasks", "in-progress"), { recursive: true });
  await mkdir(join(dataDir, "tasks", "review"), { recursive: true });
  await mkdir(join(dataDir, "tasks", "done"), { recursive: true });
  await mkdir(join(dataDir, "tasks", "blocked"), { recursive: true });
  await mkdir(join(dataDir, "tasks", "cancelled"), { recursive: true });
  await mkdir(join(dataDir, "tasks", "deadletter"), { recursive: true });
  await mkdir(join(dataDir, "org"), { recursive: true });
  await mkdir(join(dataDir, "events"), { recursive: true });
  await mkdir(join(dataDir, "views"), { recursive: true });

  // Seed org chart
  const orgChart = createTestOrgChart([
    "test-agent-1",
    "test-agent-2",
    "test-agent-3",
  ]);
  await writeFile(join(dataDir, "org", "org-chart.yaml"), orgChart);

  // Seed task fixtures if provided
  if (fixtures) {
    for (const fixture of fixtures) {
      const taskMarkdown = createTaskMarkdown(fixture);
      const taskPath = join(
        dataDir,
        "tasks",
        fixture.status,
        `${fixture.id}.md`
      );
      await writeFile(taskPath, taskMarkdown);
    }
  }
}

/**
 * Cleanup test data directory.
 */
export async function cleanupTestData(dataDir: string): Promise<void> {
  await rm(dataDir, { recursive: true, force: true });
}

/**
 * Seed multiple tasks across different statuses.
 */
export async function seedMultipleStatuses(
  dataDir: string,
  statuses: Array<{ status: TaskFixture["status"]; count: number }>
): Promise<void> {
  let taskCounter = 1;

  for (const { status, count } of statuses) {
    for (let i = 0; i < count; i++) {
      const taskId = `test-task-${String(taskCounter).padStart(3, "0")}`;
      const fixture: TaskFixture = {
        id: taskId,
        title: `Test Task ${taskCounter}`,
        status,
        priority: "P2",
      };

      const taskMarkdown = createTaskMarkdown(fixture);
      const taskPath = join(dataDir, "tasks", status, `${taskId}.md`);
      await writeFile(taskPath, taskMarkdown);
      taskCounter++;
    }
  }
}

/**
 * Count tasks in a specific status directory.
 */
export async function countTasksInStatus(
  dataDir: string,
  status: string
): Promise<number> {
  try {
    const files = await readdir(join(dataDir, "tasks", status));
    return files.filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}
