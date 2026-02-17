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
}
