/**
 * Task management CLI commands.
 * Registers all task-related subcommands (create, list, edit, etc.).
 */

import { join } from "node:path";
import type { Command } from "commander";
import { EventLogger } from "../../events/logger.js";

/**
 * Register task commands with the CLI program.
 */
export function registerTaskCommands(program: Command): void {
  const task = program
    .command("task")
    .description("Task management");

  task
    .command("create <title>")
    .description("Create a new pending task")
    .option("-p, --priority <priority>", "Priority (low|normal|high|critical)", "normal")
    .option("-t, --team <team>", "Owner team")
    .option("-a, --agent <agent>", "Target agent")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (title: string, opts: { priority: string; team?: string; agent?: string; tags?: string; project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const root = program.opts()["root"] as string;
      const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      const t = await store.create({
        title,
        priority: opts.priority,
        routing: {
          team: opts.team,
          agent: opts.agent,
          tags: opts.tags?.split(",").map(s => s.trim()) ?? [],
        },
        createdBy: "cli",
      });

      console.log(`✅ Created task: ${t.frontmatter.id}`);
      console.log(`   Title: ${t.frontmatter.title}`);
      console.log(`   Priority: ${t.frontmatter.priority}`);
      console.log(`   Status: ${t.frontmatter.status}`);
      if (opts.agent) console.log(`   Agent: ${opts.agent}`);
      if (opts.team) console.log(`   Team: ${opts.team}`);
      console.log(`   Path: ${t.path}`);
    });

  task
    .command("list")
    .description("List all tasks (alias for scan)")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (opts: { project: string }) => {
      // Delegate to scan with project option
      await program.commands.find(c => c.name() === "scan")?.parseAsync(["--project", opts.project], { from: "user" });
    });

  task
    .command("resurrect <task-id>")
    .description("Resurrect a task from deadletter status back to ready")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts: { project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const { resurrectTask } = await import("../task-resurrect.js");
      const root = program.opts()["root"] as string;
      const { store, projectRoot } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      // Create event logger for the project
      const eventLogger = new EventLogger(join(projectRoot, "events"));

      try {
        await resurrectTask(store, eventLogger, taskId, "cli");
        console.log(`✅ Task ${taskId} resurrected (deadletter → ready)`);
        console.log(`   Ready for re-dispatch on next scheduler poll.`);
      } catch (error) {
        console.error(`❌ ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });

  task
    .command("promote <task-id>")
    .description("Promote task from backlog to ready")
    .option("--force", "Bypass eligibility checks", false)
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts: { force: boolean; project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const { taskPromote } = await import("./task-promote.js");
      const root = program.opts()["root"] as string;
      const { store, projectRoot } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      const eventLogger = new EventLogger(join(projectRoot, "events"));

      await taskPromote(store, eventLogger, taskId, { force: opts.force });
    });

  task
    .command("edit <task-id>")
    .description("Edit task metadata (title, priority, assignee, team, description)")
    .option("--title <title>", "Update task title")
    .option("--priority <priority>", "Update priority (low|normal|high|critical)")
    .option("--assignee <agent>", "Update assigned agent")
    .option("--team <team>", "Update owner team")
    .option("--description <description>", "Update task description (body)")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts: { 
      title?: string; 
      priority?: string; 
      assignee?: string; 
      team?: string; 
      description?: string;
      project: string;
    }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const { taskEdit } = await import("./task-edit.js");
      const root = program.opts()["root"] as string;
      const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      await taskEdit(store, taskId, {
        title: opts.title,
        description: opts.description,
        priority: opts.priority,
        assignee: opts.assignee,
        team: opts.team,
      });
    });

  task
    .command("cancel <task-id>")
    .description("Cancel a task with optional reason")
    .option("--reason <reason>", "Cancellation reason")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts: { reason?: string; project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const { taskCancel } = await import("./task-cancel.js");
      const root = program.opts()["root"] as string;
      const { store, projectRoot } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      const eventLogger = new EventLogger(join(projectRoot, "events"));

      await taskCancel(store, eventLogger, taskId, { reason: opts.reason });
    });

  task
    .command("close <task-id>")
    .description("Close a task (transition to done)")
    .option("--recover-on-failure", "Attempt automatic recovery on failure", false)
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts: { recoverOnFailure: boolean; project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const { taskClose } = await import("./task-close.js");
      const root = program.opts()["root"] as string;
      const { store, projectRoot } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      const eventLogger = new EventLogger(join(projectRoot, "events"));

      await taskClose(store, eventLogger, taskId, { recoverOnFailure: opts.recoverOnFailure });
    });

  // --- task dep (nested subcommand) ---
  const taskDep = task
    .command("dep")
    .description("Manage task dependencies");

  taskDep
    .command("add <task-id> <blocker-id>")
    .description("Add a dependency (task will be blocked by blocker)")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, blockerId: string, opts: { project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const { taskDepAdd } = await import("./task-dep.js");
      const root = program.opts()["root"] as string;
      const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      await taskDepAdd(store, taskId, blockerId);
    });

  taskDep
    .command("remove <task-id> <blocker-id>")
    .description("Remove a dependency")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, blockerId: string, opts: { project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const { taskDepRemove } = await import("./task-dep.js");
      const root = program.opts()["root"] as string;
      const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      await taskDepRemove(store, taskId, blockerId);
    });

  task
    .command("block <task-id>")
    .description("Block a task with a reason")
    .requiredOption("--reason <text>", "Reason for blocking the task")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts: { reason: string; project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const { taskBlock } = await import("./task-block.js");
      const root = program.opts()["root"] as string;
      const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      await taskBlock(store, taskId, { reason: opts.reason });
    });

  task
    .command("unblock <task-id>")
    .description("Unblock a task")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (taskId: string, opts: { project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
      const { taskUnblock } = await import("./task-unblock.js");
      const root = program.opts()["root"] as string;
      const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
      await store.init();

      await taskUnblock(store, taskId);
    });
}
