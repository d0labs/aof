/**
 * View commands — board, watch, runbook visualization.
 * 
 * Implements view-related CLI commands for Kanban boards,
 * real-time file system watching, and runbook compliance checking.
 */

import { join } from "node:path";
import type { Command } from "commander";

/**
 * Register all view-related commands with the Commander program.
 */
export function registerViewCommands(program: Command): void {
  // --- runbook ---
  const runbook = program
    .command("runbook")
    .description("Runbook management and compliance");

  runbook
    .command("check <task-id>")
    .description("Check runbook compliance for a task")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts: { project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const root = program.opts()["root"] as string;
      const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      const task = await store.getByPrefix(taskId);
      if (!task) {
        console.log(`❌ Task not found: ${taskId}`);
        process.exitCode = 1;
        return;
      }

      const { requiredRunbook } = task.frontmatter;
      if (!requiredRunbook) {
        console.log(`ℹ️  Task ${task.frontmatter.id} has no required runbook`);
        return;
      }

      console.log(`Checking runbook compliance for ${task.frontmatter.id}...`);
      console.log(`  Required runbook: ${requiredRunbook}\n`);

      const { checkRunbookCompliance } = await import("../../schemas/deliverable.js");
      const result = checkRunbookCompliance(task.body, requiredRunbook);

      if (result.compliant) {
        console.log("✅ Task is compliant");
        console.log(`  ✓ Compliance section found`);
        console.log(`  ✓ References runbook`);
        console.log(`  ✓ Has completed checkpoints`);
      } else {
        console.log("⚠️  Task is NOT compliant\n");
        for (const warning of result.warnings) {
          console.log(`  • ${warning}`);
        }
        console.log(`\nCompliance status:`);
        console.log(`  Section found: ${result.sectionFound ? "✓" : "✗"}`);
        console.log(`  References runbook: ${result.referencesRunbook ? "✓" : "✗"}`);
        console.log(`  Has checkpoints: ${result.hasCheckpoints ? "✓" : "✗"}`);
      }
    });

  // --- board ---
  program
    .command("board")
    .description("Display Kanban board")
    .option("--swimlane <type>", "Swimlane grouping (priority|project|phase)", "priority")
    .option("--sync", "Regenerate view files before display", false)
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (opts: { swimlane: string; sync: boolean; project: string }) => {
      const { createProjectStore, getKanbanViewsDir } = await import("../project-utils.js");
      const root = program.opts()["root"] as string;
      const { store, projectRoot } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      if (opts.sync) {
        const { syncKanbanView } = await import("../../views/kanban.js");
        await syncKanbanView(store, {
          dataDir: projectRoot,
          viewsDir: getKanbanViewsDir(projectRoot),
          swimlaneBy: opts.swimlane as "priority" | "project" | "phase",
        });
      }

      const tasks = await store.list();
      const columns = new Map<string, Map<string, typeof tasks>>();

      for (const task of tasks) {
        let swimlane: string;
        if (opts.swimlane === "priority") {
          swimlane = task.frontmatter.priority;
        } else if (opts.swimlane === "phase") {
          const phase = task.frontmatter.metadata?.phase;
          swimlane = (typeof phase === "string" && phase.trim()) 
            ? phase.trim()
            : (typeof phase === "number") 
              ? String(phase) 
              : "unassigned";
        } else {
          swimlane = (task.frontmatter.metadata?.project as string) ?? "unassigned";
        }
        
        const byStatus = columns.get(swimlane) ?? new Map<string, typeof tasks>();
        const bucket = byStatus.get(task.frontmatter.status) ?? [];
        bucket.push(task);
        byStatus.set(task.frontmatter.status, bucket);
        columns.set(swimlane, byStatus);
      }

      console.log(`\n📋 Kanban Board (${opts.swimlane} swimlanes)\n`);

      const statuses = ["backlog", "ready", "in-progress", "review", "blocked", "done"];
      const swimlanes = Array.from(columns.keys()).sort();

      for (const swimlane of swimlanes) {
        console.log(`\n━━━ ${swimlane.toUpperCase()} ━━━`);
        const byStatus = columns.get(swimlane)!;

        for (const status of statuses) {
          const tasksInStatus = byStatus.get(status) ?? [];
          if (tasksInStatus.length === 0) continue;

          console.log(`\n  ${status} (${tasksInStatus.length}):`);
          for (const task of tasksInStatus) {
            const agent = task.frontmatter.lease?.agent ?? task.frontmatter.routing.agent ?? "unassigned";
            console.log(`    • ${task.frontmatter.id.slice(0, 18)} [${agent}] ${task.frontmatter.title}`);
          }
        }
      }

      console.log(`\n📊 Total: ${tasks.length} tasks\n`);
    });
}
