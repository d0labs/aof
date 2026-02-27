/**
 * AOF CLI — Agentic Ops Fabric command-line interface.
 * Built with Commander for proper arg parsing, help generation, and subcommands.
 *
 * This module configures the Commander program with all commands registered.
 * It is separated from the entrypoint (index.ts) so that tools like the CLI
 * doc generator can import the program object without triggering parseAsync.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { FilesystemTaskStore } from "../store/task-store.js";
import { EventLogger } from "../events/logger.js";
import { poll } from "../dispatch/scheduler.js";
import { validateOrgChart, showOrgChart, driftCheck } from "../commands/org.js";
import { generateMemoryConfigFile, auditMemoryConfigFile } from "../commands/memory.js";
import { loadOrgChart, lintOrgChart } from "../org/index.js";
import { getConfigValue, setConfigValue, validateConfig } from "../config/index.js";
import { startMetricsServer, AOFMetrics } from "../metrics/exporter.js";
import { collectMetrics } from "../metrics/collector.js";
import { NotificationService, MockNotificationAdapter } from "../events/notifier.js";
import type { BaseEvent } from "../schemas/event.js";
import { install, update, list } from "../packaging/installer.js";
import { getChannel, setChannel, checkForUpdates, getVersionManifest } from "../packaging/channels.js";
import { selfUpdate, rollbackUpdate } from "../packaging/updater.js";
import { runMigrations } from "../packaging/migrations.js";
import { registerInitCommand } from "./commands/init.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerTaskCommands } from "./commands/task.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerOrgCommands } from "./commands/org.js";
import { registerViewCommands } from "./commands/views.js";
import { registerSystemCommands } from "./commands/system.js";
import { registerSetupCommand } from "./commands/setup.js";

const AOF_ROOT = process.env["AOF_ROOT"] ?? resolve(homedir(), "Projects", "AOF");

const program = new Command()
  .name("aof")
  .version("0.1.0")
  .description("Agentic Ops Fabric — deterministic orchestration for multi-agent systems")
  .option("--root <path>", "AOF root directory", AOF_ROOT);


// --- init (integration wizard) ---
registerInitCommand(program);

// --- project commands ---
registerProjectCommands(program);


// --- daemon ---
registerDaemonCommands(program);

// --- lint ---
program
  .command("lint")
  .description("Lint all task files for errors")
  .option("--project <id>", "Project ID", "_inbox")
  .action(async (opts: { project: string }) => {
    const { createProjectStore } = await import("./project-utils.js");
    const root = program.opts()["root"] as string;
    const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });

    console.log(`Linting tasks in ${store.tasksDir}...`);

    const issues = await store.lint();
    if (issues.length === 0) {
      const tasks = await store.list();
      console.log(`✅ ${tasks.length} tasks scanned, 0 issues found`);
      return;
    }

    for (const { task, issue } of issues) {
      const id = task.frontmatter?.id ?? "unknown";
      console.log(`  ✗ ${id}: ${issue}`);
    }

    const tasks = await store.list();
    console.log(`\n${tasks.length} tasks, ${issues.length} issues`);
    process.exitCode = 1;
  });

// --- scan ---
program
  .command("scan")
  .description("Scan and list all tasks by status")
  .option("--project <id>", "Project ID", "_inbox")
  .action(async (opts: { project: string }) => {
    const { createProjectStore } = await import("./project-utils.js");
    const root = program.opts()["root"] as string;
    const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
    const tasks = await store.list();

    console.log(`Scanned ${tasks.length} tasks\n`);

    const byStatus = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const status = task.frontmatter.status;
      const group = byStatus.get(status);
      if (group) group.push(task);
      else byStatus.set(status, [task]);
    }

    for (const status of ["backlog", "ready", "in-progress", "review", "blocked", "done"]) {
      const group = byStatus.get(status);
      if (!group || group.length === 0) continue;

      console.log(`${status} (${group.length}):`);
      for (const task of group) {
        const agent = task.frontmatter.lease?.agent ?? task.frontmatter.routing.agent ?? "unassigned";
        console.log(`  ${task.frontmatter.id.slice(0, 8)} [${task.frontmatter.priority}] ${task.frontmatter.title} → ${agent}`);
      }
      console.log();
    }
  });

// --- scheduler ---
const scheduler = program
  .command("scheduler")
  .description("Scheduler commands");

scheduler
  .command("run")
  .description("Run one scheduler poll cycle")
  .option("--dry-run", "Dry-run mode (log only, no mutations)", false)
  .option("--project <id>", "Project ID", "_inbox")
  .action(async (opts: { dryRun: boolean; project: string }) => {
    const { createProjectStore } = await import("./project-utils.js");
    const root = program.opts()["root"] as string;
    const { store, projectRoot } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
    const logger = new EventLogger(join(projectRoot, "events"));
    await store.init();

    const dryRun = opts.dryRun;
    console.log(`🔄 Scheduler poll (${dryRun ? "DRY RUN" : "ACTIVE"})...\n`);

    const result = await poll(store, logger, {
      dataDir: projectRoot,
      dryRun,
      defaultLeaseTtlMs: 600_000,
    });

    console.log("📊 Task stats:");
    console.log(`   Total: ${result.stats.total}`);
    console.log(`   Backlog: ${result.stats.backlog} | Ready: ${result.stats.ready} | In-Progress: ${result.stats.inProgress}`);
    console.log(`   Blocked: ${result.stats.blocked} | Review: ${result.stats.review} | Done: ${result.stats.done}`);
    console.log();

    if (result.actions.length === 0) {
      console.log("✅ No actions needed");
    } else {
      console.log(`${dryRun ? "📋 Planned" : "⚡ Executed"} actions (${result.actions.length}):`);
      for (const action of result.actions) {
        const icon = action.type === "expire_lease" ? "⏰"
          : action.type === "assign" ? "📬"
          : action.type === "requeue" ? "🔄"
          : action.type === "deadletter" ? "💀"
          : "🔔";
        console.log(`  ${icon} [${action.type}] ${action.taskId.slice(0, 8)} "${action.taskTitle}"`);
        console.log(`     ${action.reason}`);
        if (action.agent) console.log(`     agent: ${action.agent}`);
      }
    }

    console.log(`\nCompleted in ${result.durationMs}ms`);
  });

// --- task ---
registerTaskCommands(program);

// --- org ---
registerOrgCommands(program);

// --- views ---
registerViewCommands(program);

// --- memory ---
registerMemoryCommands(program);

// --- system ---
registerSystemCommands(program);

// --- setup (installer post-extraction) ---
registerSetupCommand(program);

export { program };
