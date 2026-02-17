#!/usr/bin/env node

/**
 * AOF CLI — Agentic Ops Fabric command-line interface.
 * Built with Commander for proper arg parsing, help generation, and subcommands.
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
import { init } from "./init.js";
import { integrateWithOpenClaw, detectOpenClawConfig } from "../packaging/integration.js";
import { ejectFromOpenClaw, detectOpenClawIntegration } from "../packaging/ejector.js";
import { migrateToProjects, rollbackMigration } from "../projects/migration.js";
import { daemonStart, daemonStop, daemonStatus, daemonRestart } from "./commands/daemon.js";

const AOF_ROOT = process.env["AOF_ROOT"] ?? resolve(homedir(), "Projects", "AOF");

const program = new Command()
  .name("aof")
  .version("0.1.0")
  .description("Agentic Ops Fabric — deterministic orchestration for multi-agent systems")
  .option("--root <path>", "AOF root directory", AOF_ROOT);

// --- init ---
program
  .command("init")
  .description("Initialize a new AOF installation")
  .option("--dir <path>", "Installation directory")
  .option("--template <name>", "Template name (minimal or full)", "minimal")
  .option("-y, --yes", "Non-interactive mode (use defaults)", false)
  .option("--skip-openclaw", "Skip OpenClaw integration check", false)
  .option("--force", "Force overwrite existing installation", false)
  .action(async (opts: { dir?: string; template?: string; yes: boolean; skipOpenclaw: boolean; force: boolean }) => {
    await init({
      dir: opts.dir,
      template: opts.template as "minimal" | "full" | undefined,
      yes: opts.yes,
      skipOpenclaw: opts.skipOpenclaw,
      force: opts.force,
    });
  });

// --- create-project ---
program
  .command("create-project <id>")
  .description("Create a new project with standard directory structure")
  .option("--title <title>", "Project title (defaults to ID)")
  .option("--type <type>", "Project type (swe|ops|research|admin|personal|other)", "other")
  .option("--team <team>", "Owner team (defaults to 'system')", "system")
  .option("--lead <lead>", "Owner lead (defaults to 'system')", "system")
  .option("--parent <id>", "Parent project ID for hierarchical projects")
  .action(async (id: string, opts: { title?: string; type: string; team: string; lead: string; parent?: string }) => {
    const { createProject } = await import("../projects/create.js");
    const root = program.opts()["root"] as string;

    try {
      const result = await createProject(id, {
        vaultRoot: root,
        title: opts.title,
        type: opts.type as "swe" | "ops" | "research" | "admin" | "personal" | "other",
        owner: { team: opts.team, lead: opts.lead },
        parentId: opts.parent,
      });

      console.log(`✅ Project created: ${id}`);
      console.log(`   Title: ${result.manifest.title}`);
      console.log(`   Type: ${result.manifest.type}`);
      console.log(`   Path: ${result.projectRoot}`);
      console.log(`   Directories: ${result.directoriesCreated.join(", ")}`);
      if (result.manifest.parentId) {
        console.log(`   Parent: ${result.manifest.parentId}`);
      }
    } catch (error) {
      console.error(`❌ Failed to create project: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

// --- integrate ---
const integrate = program
  .command("integrate")
  .description("Integration commands");

integrate
  .command("openclaw")
  .description("Wire AOF plugin into OpenClaw")
  .option("--config <path>", "Path to OpenClaw config file")
  .option("--health-check", "Run health check after integration", false)
  .action(async (opts: { config?: string; healthCheck: boolean }) => {
    const root = program.opts()["root"] as string;
    const homeDir = homedir();

    console.log("🔌 Integrating AOF with OpenClaw...\n");

    // Step 1: Detect OpenClaw config
    const detection = await detectOpenClawConfig(homeDir);
    if (!detection.detected && !opts.config) {
      console.error("❌ OpenClaw config not found at ~/.openclaw/openclaw.json");
      console.error("   Use --config to specify a custom path");
      process.exitCode = 1;
      return;
    }

    const configPath = opts.config ?? detection.configPath!;
    console.log(`   OpenClaw config: ${configPath}`);
    console.log(`   AOF root: ${root}\n`);

    // Step 2: Integrate
    const result = await integrateWithOpenClaw({
      aofRoot: root,
      openclawConfigPath: configPath,
      homeDir,
      healthCheck: opts.healthCheck,
    });

    if (!result.success) {
      console.error(`❌ Integration failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }

    if (result.alreadyIntegrated) {
      console.log("ℹ️  AOF plugin is already integrated");
      return;
    }

    console.log("✅ Integration complete!\n");
    console.log("   Plugin registered: ✓");
    console.log("   Memory scoping configured: ✓");
    if (result.backupCreated) {
      console.log(`   Backup created: ${result.backupPath}`);
    }
    if (result.validationPassed) {
      console.log("   Config validated: ✓");
    }
    if (result.healthCheckPassed !== undefined) {
      console.log(`   Health check: ${result.healthCheckPassed ? "✓" : "✗"}`);
    }

    if (result.warnings && result.warnings.length > 0) {
      console.log("\n⚠️  Warnings:");
      for (const warning of result.warnings) {
        console.log(`   • ${warning}`);
      }
    }

    console.log("\n💡 Next steps:");
    console.log("   1. Restart OpenClaw Gateway: openclaw gateway restart");
    console.log("   2. Verify plugin loaded: openclaw gateway status");
  });

// --- eject ---
const eject = program
  .command("eject")
  .description("Ejection commands");

eject
  .command("openclaw")
  .description("Remove OpenClaw integration")
  .option("--config <path>", "Path to OpenClaw config file")
  .action(async (opts: { config?: string }) => {
    const root = program.opts()["root"] as string;
    const homeDir = homedir();

    console.log("🔌 Ejecting AOF from OpenClaw...\n");

    // Step 1: Determine config path
    let configPath: string;
    if (opts.config) {
      configPath = opts.config;
    } else {
      const detection = await detectOpenClawConfig(homeDir);
      if (!detection.detected) {
        console.error("❌ OpenClaw config not found at ~/.openclaw/openclaw.json");
        console.error("   Use --config to specify a custom path");
        process.exitCode = 1;
        return;
      }
      configPath = detection.configPath!;
    }

    console.log(`   OpenClaw config: ${configPath}`);
    console.log(`   AOF root: ${root}\n`);

    // Step 2: Check if integrated
    const integrationCheck = await detectOpenClawIntegration(configPath);
    if (!integrationCheck.integrated) {
      console.log("ℹ️  AOF is not integrated with OpenClaw");
      console.log("   No action needed");
      return;
    }

    // Step 3: Eject
    const result = await ejectFromOpenClaw({
      openclawConfigPath: configPath,
      homeDir,
    });

    if (!result.success) {
      console.error(`❌ Ejection failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }

    if (result.alreadyEjected) {
      console.log("ℹ️  AOF plugin is already ejected");
      return;
    }

    console.log("✅ Ejection complete!\n");
    console.log("   Plugin removed: ✓");
    if (result.backupCreated) {
      console.log(`   Backup created: ${result.backupPath}`);
    }
    if (result.validationPassed) {
      console.log("   Config validated: ✓");
    }

    if (result.warnings && result.warnings.length > 0) {
      console.log("\n⚠️  Warnings:");
      for (const warning of result.warnings) {
        console.log(`   • ${warning}`);
      }
    }

    console.log("\n💡 Next steps:");
    console.log("   1. Restart OpenClaw Gateway: openclaw gateway restart");
    console.log("   2. AOF now runs standalone (no OpenClaw integration)");
    console.log("   3. To re-integrate: aof integrate openclaw");
  });

// --- daemon ---
const daemon = program
  .command("daemon")
  .description("Daemon management commands");

daemon
  .command("start")
  .description("Start the AOF daemon in background")
  .option("--port <number>", "HTTP port", "18000")
  .option("--bind <address>", "Bind address", "127.0.0.1")
  .option("--data-dir <path>", "Data directory")
  .option("--log-level <level>", "Log level", "info")
  .action(async (opts: { port: string; bind: string; dataDir?: string; logLevel: string }) => {
    const root = program.opts()["root"] as string;
    const dataDir = opts.dataDir ?? root;
    await daemonStart(dataDir, opts);
  });

daemon
  .command("stop")
  .description("Stop the running daemon")
  .option("--timeout <seconds>", "Shutdown timeout in seconds", "10")
  .action(async (opts: { timeout: string }) => {
    const root = program.opts()["root"] as string;
    await daemonStop(root, opts);
  });

daemon
  .command("status")
  .description("Check daemon status")
  .option("--port <number>", "HTTP port (for health endpoint display)", "18000")
  .option("--bind <address>", "Bind address (for health endpoint display)", "127.0.0.1")
  .action(async (opts: { port: string; bind: string }) => {
    const root = program.opts()["root"] as string;
    await daemonStatus(root, opts.port, opts.bind);
  });

daemon
  .command("restart")
  .description("Restart the daemon")
  .option("--port <number>", "HTTP port", "18000")
  .option("--bind <address>", "Bind address", "127.0.0.1")
  .option("--data-dir <path>", "Data directory")
  .option("--log-level <level>", "Log level", "info")
  .action(async (opts: { port: string; bind: string; dataDir?: string; logLevel: string }) => {
    const root = program.opts()["root"] as string;
    const dataDir = opts.dataDir ?? root;
    await daemonRestart(dataDir, opts);
  });

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
  .option("--active", "Active mode (mutate state)", false)
  .option("--project <id>", "Project ID", "_inbox")
  .action(async (opts: { active: boolean; project: string }) => {
    const { createProjectStore } = await import("./project-utils.js");
    const root = program.opts()["root"] as string;
    const { store, projectRoot } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
    const logger = new EventLogger(join(projectRoot, "events"));
    await store.init();

    const dryRun = !opts.active;
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
    const { createProjectStore } = await import("./project-utils.js");
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
    const { createProjectStore } = await import("./project-utils.js");
    const { resurrectTask } = await import("./task-resurrect.js");
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
    const { createProjectStore } = await import("./project-utils.js");
    const { taskPromote } = await import("./commands/task-promote.js");
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
    const { createProjectStore } = await import("./project-utils.js");
    const { taskEdit } = await import("./commands/task-edit.js");
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
    const { createProjectStore } = await import("./project-utils.js");
    const { taskCancel } = await import("./commands/task-cancel.js");
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
    const { createProjectStore } = await import("./project-utils.js");
    const { taskClose } = await import("./commands/task-close.js");
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
    const { createProjectStore } = await import("./project-utils.js");
    const { taskDepAdd } = await import("./commands/task-dep.js");
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
    const { createProjectStore } = await import("./project-utils.js");
    const { taskDepRemove } = await import("./commands/task-dep.js");
    const root = program.opts()["root"] as string;
    const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
    await store.init();

    await taskDepRemove(store, taskId, blockerId);
  });

// --- org ---
const org = program
  .command("org")
  .description("Org chart management");

org
  .command("validate [path]")
  .description("Validate org chart schema")
  .action(async (path?: string) => {
    const root = program.opts()["root"] as string;
    await validateOrgChart(path ?? join(root, "org", "org-chart.yaml"));
  });

org
  .command("show [path]")
  .description("Display org chart")
  .action(async (path?: string) => {
    const root = program.opts()["root"] as string;
    await showOrgChart(path ?? join(root, "org", "org-chart.yaml"));
  });

org
  .command("lint [path]")
  .description("Lint org chart (referential integrity)")
  .action(async (path?: string) => {
    const root = program.opts()["root"] as string;
    const orgPath = path ?? join(root, "org", "org-chart.yaml");
    console.log(`Linting org chart at ${orgPath}...\n`);

    const result = await loadOrgChart(orgPath);
    if (!result.success) {
      console.error("❌ Schema validation failed:");
      for (const err of result.errors ?? []) {
        console.error(`  ${err.path}: ${err.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const issues = lintOrgChart(result.chart!);
    if (issues.length === 0) {
      console.log(`✅ Org chart valid: ${result.chart!.agents.length} agents, ${result.chart!.teams.length} teams — 0 issues`);
      return;
    }

    for (const issue of issues) {
      const icon = issue.severity === "error" ? "✗" : "⚠";
      console.log(`  ${icon} [${issue.rule}] ${issue.message}`);
    }

    const errors = issues.filter(i => i.severity === "error");
    const warnings = issues.filter(i => i.severity === "warning");
    console.log(`\n${errors.length} errors, ${warnings.length} warnings`);
    if (errors.length > 0) process.exitCode = 1;
  });

org
  .command("drift [path]")
  .description("Detect drift between org chart and OpenClaw agents")
  .option("--source <type>", "Source for OpenClaw agents: fixture or live", "fixture")
  .option("--fixture <path>", "Path to fixture JSON file (when --source=fixture)")
  .action(async (path?: string, opts?: { source: string; fixture?: string }) => {
    const root = program.opts()["root"] as string;
    const orgPath = path ?? join(root, "org", "org-chart.yaml");
    const source = (opts?.source ?? "fixture") as "fixture" | "live";
    
    let fixturePath: string | undefined;
    if (source === "fixture") {
      fixturePath = opts?.fixture ?? join(root, "tests", "fixtures", "openclaw-agents.json");
    }

    console.log(`Checking drift: ${orgPath}`);
    console.log(`Source: ${source}${fixturePath ? ` (${fixturePath})` : ""}\n`);

    await driftCheck(orgPath, source, fixturePath);
  });

// --- runbook ---
const runbook = program
  .command("runbook")
  .description("Runbook management and compliance");

runbook
  .command("check <task-id>")
  .description("Check runbook compliance for a task")
  .option("--project <id>", "Project ID", "_inbox")
  .action(async (taskId: string, opts: { project: string }) => {
    const { createProjectStore } = await import("./project-utils.js");
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

    const { checkRunbookCompliance } = await import("../schemas/deliverable.js");
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
    const { createProjectStore, getKanbanViewsDir } = await import("./project-utils.js");
    const root = program.opts()["root"] as string;
    const { store, projectRoot } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
    await store.init();

    if (opts.sync) {
      const { syncKanbanView } = await import("../views/kanban.js");
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

// --- watch ---
program
  .command("watch <viewType> [viewPath]")
  .description("Watch a view directory for real-time updates")
  .option("--format <format>", "Output format (cli|json|jsonl)", "cli")
  .option("--agent <agent>", "Filter by agent (mailbox views only)")
  .option("--project <id>", "Project ID", "_inbox")
  .action(async (viewType: string, viewPath?: string, opts?: { format: string; agent?: string; project: string }) => {
    const { resolveProject } = await import("../projects/resolver.js");
    const root = program.opts()["root"] as string;
    const format = opts?.format ?? "cli";
    const projectId = opts?.project ?? "_inbox";

    if (!["kanban", "mailbox"].includes(viewType)) {
      console.error(`❌ Invalid view type: ${viewType}`);
      console.error("   Supported: kanban, mailbox");
      process.exitCode = 1;
      return;
    }

    if (!["cli", "json", "jsonl"].includes(format)) {
      console.error(`❌ Invalid format: ${format}`);
      console.error("   Supported: cli, json, jsonl");
      process.exitCode = 1;
      return;
    }

    // Resolve project root
    const resolution = await resolveProject(projectId, root);

    // Resolve view directory
    let resolvedViewPath: string;
    if (viewPath) {
      resolvedViewPath = viewPath;
    } else if (viewType === "kanban") {
      // Default kanban path under project
      resolvedViewPath = join(resolution.projectRoot, "views", "kanban", "priority");
    } else {
      // Mailbox requires agent
      if (!opts?.agent) {
        console.error("❌ --agent required for mailbox views");
        console.error("   Example: aof watch mailbox --agent swe-backend --project _inbox");
        process.exitCode = 1;
        return;
      }
      resolvedViewPath = join(resolution.projectRoot, "views", "mailbox", opts.agent);
    }

    const { ViewWatcher } = await import("../views/watcher.js");
    const { parseViewSnapshot } = await import("../views/parser.js");
    const { renderCLI, renderJSON, renderJSONL } = await import("../views/renderers.js");

    // Initial render
    try {
      const snapshot = await parseViewSnapshot(resolvedViewPath, viewType as "kanban" | "mailbox");
      
      if (format === "cli") {
        console.log(renderCLI(snapshot));
      } else if (format === "json") {
        console.log(renderJSON(snapshot));
      } else {
        process.stdout.write(renderJSONL({ type: "add", path: resolvedViewPath, viewType: viewType as any, timestamp: snapshot.timestamp }, snapshot));
      }
    } catch (error) {
      console.error(`❌ Failed to read view: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }

    // Start watching
    const watcher = new ViewWatcher({
      viewDir: resolvedViewPath,
      viewType: viewType as "kanban" | "mailbox",
      debounceMs: 100,
      onEvent: async (event) => {
        try {
          const snapshot = await parseViewSnapshot(resolvedViewPath, viewType as "kanban" | "mailbox");

          if (format === "cli") {
            // Clear screen and re-render
            console.clear();
            console.log(renderCLI(snapshot));
          } else if (format === "json") {
            console.log(renderJSON(snapshot));
          } else {
            process.stdout.write(renderJSONL(event, snapshot));
          }
        } catch (error) {
          console.error(`⚠️  Failed to parse view: ${(error as Error).message}`);
        }
      },
    });

    try {
      await watcher.start();
      
      if (format === "cli") {
        console.log(`\n👁️  Watching ${resolvedViewPath}`);
        console.log("   Press Ctrl+C to stop\n");
      }

      // Keep process alive
      const shutdown = async () => {
        if (format === "cli") {
          console.log("\n🛑 Stopping watcher...");
        }
        await watcher.stop();
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    } catch (error) {
      console.error(`❌ Failed to start watcher: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

// --- memory ---
const memory = program
  .command("memory")
  .description("Memory V2 commands");

memory
  .command("generate [path]")
  .description("Generate OpenClaw memory config from org chart")
  .option("--out <path>", "Output path for generated config")
  .option("--vault-root <path>", "Vault root for resolving memory pool paths")
  .action(async (path?: string, opts?: { out?: string; vaultRoot?: string }) => {
    const root = program.opts()["root"] as string;
    const orgPath = path ?? join(root, "org", "org-chart.yaml");
    const outputPath = opts?.out ?? join(root, "org", "generated", "memory-config.json");
    const vaultRoot = opts?.vaultRoot ?? process.env["AOF_VAULT_ROOT"] ?? process.env["OPENCLAW_VAULT_ROOT"];

    await generateMemoryConfigFile({
      orgChartPath: orgPath,
      outputPath,
      vaultRoot: vaultRoot ?? undefined,
    });
  });

memory
  .command("audit [path]")
  .description("Audit OpenClaw memory config against org chart")
  .option("--config <path>", "Path to OpenClaw config file")
  .option("--vault-root <path>", "Vault root for resolving memory pool paths")
  .action(async (path?: string, opts?: { config?: string; vaultRoot?: string }) => {
    const root = program.opts()["root"] as string;
    const orgPath = path ?? join(root, "org", "org-chart.yaml");
    const vaultRoot = opts?.vaultRoot ?? process.env["AOF_VAULT_ROOT"] ?? process.env["OPENCLAW_VAULT_ROOT"];
    const configPath = opts?.config
      ?? process.env["OPENCLAW_CONFIG"]
      ?? join(homedir(), ".openclaw", "openclaw.json");

    await auditMemoryConfigFile({
      orgChartPath: orgPath,
      configPath,
      vaultRoot: vaultRoot ?? undefined,
    });
  });

memory
  .command("aggregate")
  .description("Aggregate cold tier events into warm docs")
  .option("--dry-run", "Preview changes without writing", false)
  .action(async (opts: { dryRun: boolean }) => {
    const root = program.opts()["root"] as string;
    const { WarmAggregator } = await import("../memory/warm-aggregation.js");
    const aggregator = new WarmAggregator(root);

    console.log(`🔄 Aggregating cold → warm...${opts.dryRun ? " (DRY RUN)" : ""}\n`);

    const result = await aggregator.aggregate();

    console.log(`✅ Processed ${result.eventsProcessed} cold events`);
    console.log(`✅ Updated ${result.warmDocsUpdated} warm docs`);

    if (result.errors.length > 0) {
      console.log(`\n⚠️  Errors (${result.errors.length}):`);
      for (const err of result.errors) {
        console.log(`  ${err.rule}: ${err.error}`);
      }
    }

    console.log(`\n⚡ Completed in ${result.durationMs}ms`);
  });

memory
  .command("promote")
  .description("Promote warm doc to hot tier (gated review)")
  .requiredOption("--from <path>", "Source warm doc path")
  .requiredOption("--to <path>", "Target hot doc path")
  .option("--review", "Show diff and prompt for approval", true)
  .option("--approve", "Auto-approve without review", false)
  .action(async (opts: { from: string; to: string; review: boolean; approve: boolean }) => {
    const root = program.opts()["root"] as string;
    const { HotPromotion } = await import("../memory/hot-promotion.js");
    const promotion = new HotPromotion(root);

    console.log("🔍 Reviewing promotion:");
    console.log(`  From: ${opts.from}`);
    console.log(`  To: ${opts.to}\n`);

    const hotSize = await promotion.getHotSize();
    console.log(`  Hot tier size: ${hotSize} bytes (limit: 50,000 bytes)\n`);

    if (opts.review && !opts.approve) {
      const diff = await promotion.generateDiff(opts.from, opts.to);
      console.log("  Diff preview:");
      console.log(diff.split("\n").map(l => `    ${l}`).join("\n"));
      console.log("\n  ⚠️  Use --approve to apply this promotion");
      return;
    }

    const result = await promotion.promote({
      from: opts.from,
      to: opts.to,
      approved: opts.approve,
    });

    if (result.success) {
      console.log(`✅ Promotion successful`);
      console.log(`  New hot tier size: ${result.hotSize} bytes`);
    } else {
      console.log(`❌ Promotion failed: ${result.error ?? "unknown error"}`);
      process.exitCode = 1;
    }
  });

memory
  .command("curate")
  .description("Generate memory curation tasks based on adaptive thresholds")
  .option("--policy <path>", "Path to curation policy file (YAML)")
  .option("--org <path>", "Path to org chart (overrides default)")
  .option("--entries <count>", "Manual entry count override (for lancedb)")
  .option("--project <id>", "Project ID for task store", "_inbox")
  .option("--dry-run", "Preview tasks without creating", false)
  .action(async (opts: { policy?: string; org?: string; entries?: string; project: string; dryRun: boolean }) => {
    const root = program.opts()["root"] as string;
    const projectId = opts.project;

    // Resolve project root
    const { resolveProject } = await import("../projects/resolver.js");
    const resolution = await resolveProject(projectId, root);

    // Load org chart
    const orgPath = opts.org ?? join(root, "org", "org-chart.yaml");
    let orgChart: import("../schemas/org-chart.js").OrgChart | undefined;
    try {
      const result = await loadOrgChart(orgPath);
      if (result.success) {
        orgChart = result.chart;
      } else {
        console.error(`⚠️  Could not load org chart: validation failed`);
        console.error("   Continuing without org chart reference...");
      }
    } catch (error) {
      console.error(`⚠️  Could not load org chart: ${(error as Error).message}`);
      console.error("   Continuing without org chart reference...");
    }

    // Resolve policy path
    let policyPath: string;
    if (opts.policy) {
      policyPath = opts.policy;
    } else if (orgChart?.memoryCuration?.policyPath) {
      policyPath = join(root, orgChart.memoryCuration.policyPath);
    } else {
      console.error("❌ No policy specified. Use --policy or configure memoryCuration in org chart.");
      process.exitCode = 1;
      return;
    }

    // Load policy
    const { loadCurationPolicy } = await import("../memory/curation-policy.js");
    let policy: import("../memory/curation-policy.js").CurationPolicy;
    try {
      policy = await loadCurationPolicy(policyPath);
    } catch (error) {
      console.error(`❌ Failed to load policy: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`📋 Curation Policy: ${policyPath}`);
    console.log(`   Strategy: ${policy.strategy}`);
    console.log(`   Thresholds: ${policy.thresholds.length}`);
    if (opts.dryRun) {
      console.log(`   Mode: DRY RUN`);
    }
    console.log();

    // Detect backend
    const { detectMemoryBackend, supportsAutomaticInventory } = await import("../memory/host-detection.js");
    const detection = await detectMemoryBackend();
    console.log(`🔍 Memory Backend: ${detection.backend} (${detection.source})`);

    // Build inventory
    const { resolvePoolPath } = await import("../memory/generator.js");
    const vaultRoot = process.env["AOF_VAULT_ROOT"] ?? process.env["OPENCLAW_VAULT_ROOT"] ?? root;
    const scopes: Array<import("../memory/curation-generator.js").CurationScope> = [];

    if (detection.backend === "memory-lancedb") {
      if (!opts.entries) {
        console.error("❌ memory-lancedb requires --entries override (stats API not yet available)");
        process.exitCode = 1;
        return;
      }
      const entryCount = parseInt(opts.entries, 10);
      if (Number.isNaN(entryCount) || entryCount < 0) {
        console.error("❌ Invalid --entries value (must be non-negative integer)");
        process.exitCode = 1;
        return;
      }
      scopes.push({ type: "pool", id: "lancedb", entryCount });
    } else if (orgChart?.memoryPools) {
      // Count entries in each pool
      const { readdir, stat: statFile } = await import("node:fs/promises");

      async function countFiles(dir: string): Promise<number> {
        let count = 0;
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              count += await countFiles(join(dir, entry.name));
            } else if (entry.isFile()) {
              count++;
            }
          }
        } catch {
          // Ignore missing directories
        }
        return count;
      }

      // Hot pool
      const hotPath = resolvePoolPath(orgChart.memoryPools.hot.path, vaultRoot);
      const hotCount = await countFiles(hotPath);
      scopes.push({ type: "pool", id: "hot", entryCount: hotCount });

      // Warm pools
      for (const pool of orgChart.memoryPools.warm) {
        const poolPath = resolvePoolPath(pool.path, vaultRoot);
        const poolCount = await countFiles(poolPath);
        scopes.push({ type: "pool", id: pool.id, entryCount: poolCount });
      }
    } else {
      console.error("❌ No memory pools configured in org chart");
      process.exitCode = 1;
      return;
    }

    console.log(`\n📊 Inventory:`);
    for (const scope of scopes) {
      console.log(`   ${scope.type}:${scope.id} → ${scope.entryCount} entries`);
    }
    console.log();

    // Generate tasks
    const taskStore = new FilesystemTaskStore(resolution.projectRoot);
    await taskStore.init();

    const { generateCurationTasks } = await import("../memory/curation-generator.js");
    const result = await generateCurationTasks(
      taskStore,
      policy,
      scopes,
      detection.backend,
      policyPath,
      { dryRun: opts.dryRun }
    );

    // Report results
    if (result.tasksCreated.length > 0) {
      console.log(`✅ Created ${result.tasksCreated.length} curation task(s):`);
      for (const task of result.tasksCreated) {
        const scopeId = task.frontmatter.metadata.scopeId as string;
        const entryCount = task.frontmatter.metadata.entryCount as number;
        console.log(`   ${task.frontmatter.id} - ${scopeId} (${entryCount} entries)`);
      }
      console.log();
    }

    if (result.skipped.length > 0) {
      console.log(`⏭️  Skipped ${result.skipped.length} scope(s):`);
      for (const skip of result.skipped) {
        console.log(`   ${skip.scope.id}: ${skip.reason}`);
      }
      console.log();
    }

    if (result.warnings.length > 0) {
      console.log(`⚠️  Warnings:`);
      for (const warning of result.warnings) {
        console.log(`   ${warning}`);
      }
      console.log();
    }

    if (result.tasksCreated.length === 0 && result.skipped.length === 0) {
      console.log("ℹ️  No curation tasks needed at this time");
    }
  });

// --- config ---
const config = program
  .command("config")
  .description("Configuration management (CLI-gated)");

config
  .command("get <key>")
  .description("Get config value (dot-notation)")
  .action(async (key: string) => {
    const root = program.opts()["root"] as string;
    const configPath = join(root, "org", "org-chart.yaml");
    const value = await getConfigValue(configPath, key);
    if (value === undefined) {
      console.log(`Key '${key}' not found`);
      process.exitCode = 1;
    } else {
      console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
    }
  });

config
  .command("set <key> <value>")
  .description("Set config value (validates + atomic write)")
  .option("--dry-run", "Preview change without applying", false)
  .action(async (key: string, value: string, opts: { dryRun: boolean }) => {
    const root = program.opts()["root"] as string;
    const configPath = join(root, "org", "org-chart.yaml");
    const result = await setConfigValue(configPath, key, value, opts.dryRun);
    const errors = result.issues.filter(i => i.severity === "error");

    if (opts.dryRun) {
      console.log(`[DRY RUN] Would update ${key}:`);
    } else if (errors.length > 0) {
      console.log("❌ Config change rejected:");
    } else {
      console.log(`✅ Config updated: ${key}`);
    }

    const fmt = (v: unknown) => v === undefined ? "undefined" : typeof v === "object" ? JSON.stringify(v) : String(v);
    console.log(`  ${key}: ${fmt(result.change.oldValue)} → ${fmt(result.change.newValue)}`);

    if (result.issues.length > 0) {
      console.log("\nIssues:");
      for (const issue of result.issues) {
        const icon = issue.severity === "error" ? "✗" : "⚠";
        console.log(`  ${icon} ${issue.message}`);
      }
    }

    if (errors.length > 0) process.exitCode = 1;
  });

config
  .command("validate")
  .description("Validate entire config (schema + integrity)")
  .action(async () => {
    const root = program.opts()["root"] as string;
    const configPath = join(root, "org", "org-chart.yaml");
    const result = await validateConfig(configPath);

    if (result.schemaErrors.length > 0) {
      console.log("❌ Schema validation failed:");
      for (const err of result.schemaErrors) {
        console.log(`  ✗ ${err.path}: ${err.message}`);
      }
      process.exitCode = 1;
      return;
    }

    for (const issue of result.lintIssues) {
      const icon = issue.severity === "error" ? "✗" : "⚠";
      console.log(`  ${icon} [${issue.rule}] ${issue.message}`);
    }

    if (result.valid) {
      console.log("✅ Config valid");
    } else {
      process.exitCode = 1;
    }
  });

// --- metrics ---
const metrics = program
  .command("metrics")
  .description("Metrics and observability");

metrics
  .command("serve")
  .description("Start Prometheus metrics HTTP server")
  .option("-p, --port <port>", "HTTP port", "9090")
  .option("--project <id>", "Project ID", "_inbox")
  .action(async (opts: { port: string; project: string }) => {
    const { createProjectStore } = await import("./project-utils.js");
    const root = program.opts()["root"] as string;
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(`❌ Invalid port: ${opts.port}`);
      process.exitCode = 1;
      return;
    }

    const { store } = await createProjectStore({ projectId: opts.project, vaultRoot: root });
    await store.init();
    const metricsRegistry = new AOFMetrics();

    const server = startMetricsServer(port, metricsRegistry, async () => {
      return collectMetrics(store);
    });

    console.log(`📊 Metrics server started on http://localhost:${port}/metrics`);
    console.log(`   Health check: http://localhost:${port}/health`);
    console.log(`   Press Ctrl+C to stop`);

    const shutdown = () => {
      console.log("\n🛑 Shutting down metrics server...");
      server.close(() => {
        console.log("✅ Metrics server stopped");
        process.exit(0);
      });
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });

// --- notifications ---
const notifications = program
  .command("notifications")
  .description("Notification system testing");

notifications
  .command("test")
  .description("Test notification system with sample events")
  .option("--dry-run", "Print notifications without sending", false)
  .action(async (opts: { dryRun: boolean }) => {
    const adapter = new MockNotificationAdapter();
    const service = new NotificationService(adapter, { enabled: !opts.dryRun });

    const testEvents: BaseEvent[] = [
      {
        eventId: 1,
        type: "task.created",
        timestamp: new Date().toISOString(),
        actor: "cli",
        taskId: "TASK-2026-02-07-TEST-001",
        payload: { title: "Test task" },
      },
      {
        eventId: 2,
        type: "task.transitioned",
        timestamp: new Date().toISOString(),
        actor: "swe-backend",
        taskId: "TASK-2026-02-07-TEST-001",
        payload: { from: "ready", to: "in-progress" },
      },
      {
        eventId: 3,
        type: "task.transitioned",
        timestamp: new Date().toISOString(),
        actor: "swe-backend",
        taskId: "TASK-2026-02-07-TEST-001",
        payload: { from: "in-progress", to: "done" },
      },
      {
        eventId: 4,
        type: "system.drift-detected",
        timestamp: new Date().toISOString(),
        actor: "system",
        payload: { summary: "2 agents missing" },
      },
      {
        eventId: 5,
        type: "lease.expired",
        timestamp: new Date().toISOString(),
        actor: "scheduler",
        taskId: "TASK-2026-02-07-TEST-002",
        payload: {},
      },
    ];

    console.log(`📬 Testing notification system (${opts.dryRun ? "DRY RUN" : "LIVE"})...\n`);

    for (const event of testEvents) {
      await service.notify(event);
    }

    if (opts.dryRun) {
      console.log("📋 Notifications that would be sent:\n");
      for (const { channel, message } of adapter.sent) {
        console.log(`  ${channel}: ${message}`);
      }
      console.log(`\n✅ ${adapter.sent.length} notifications would be sent`);
    } else {
      console.log(`✅ ${adapter.sent.length} test notifications sent`);
    }
  });

// --- install ---
program
  .command("install")
  .description("Install AOF and dependencies")
  .option("--no-lockfile", "Skip lockfile (use npm install instead of npm ci)")
  .option("--strict", "Fail if lockfile is missing", false)
  .action(async (opts: { lockfile: boolean; strict: boolean }) => {
    const root = program.opts()["root"] as string;

    console.log("📦 Installing AOF dependencies...\n");

    try {
      const result = await install({
        cwd: root,
        useLockfile: opts.lockfile,
        strict: opts.strict,
        healthCheck: true,
      });

      console.log(`✅ Installation complete!`);
      console.log(`   Command: ${result.command}`);
      console.log(`   Installed: ${result.installed} packages`);
      if (result.warnings && result.warnings.length > 0) {
        console.log(`   ⚠️  Warnings:`);
        for (const warning of result.warnings) {
          console.log(`      - ${warning}`);
        }
      }
    } catch (error) {
      console.error(`❌ Installation failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// --- deps ---
const deps = program
  .command("deps")
  .description("Dependency management commands");

deps
  .command("update")
  .description("Update dependencies")
  .option("--preserve <paths...>", "Paths to preserve during update", ["config", "data", "tasks", "events"])
  .option("--no-lockfile", "Skip lockfile (use npm install instead of npm ci)")
  .action(async (opts: { preserve: string[]; lockfile: boolean }) => {
    const root = program.opts()["root"] as string;

    console.log("🔄 Updating dependencies...\n");

    try {
      const result = await update({
        cwd: root,
        useLockfile: opts.lockfile,
        healthCheck: true,
        preservePaths: opts.preserve,
      });

      console.log(`✅ Update complete!`);
      console.log(`   Command: ${result.command}`);
      console.log(`   Installed: ${result.installed} packages`);
      if (result.backupCreated) {
        console.log(`   💾 Backup created: ${result.backupPath}`);
      }
    } catch (error) {
      console.error(`❌ Update failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

deps
  .command("list")
  .description("Show installed package versions")
  .option("--prod", "Show only production dependencies", false)
  .option("--dev", "Show only dev dependencies", false)
  .action(async (opts: { prod: boolean; dev: boolean }) => {
    const root = program.opts()["root"] as string;

    try {
      const packages = await list({ cwd: root });

      if (packages.length === 0) {
        console.log("No packages installed. Run 'aof install' first.");
        return;
      }

      let filtered = packages;
      if (opts.prod) {
        filtered = packages.filter(p => p.type === "prod");
      } else if (opts.dev) {
        filtered = packages.filter(p => p.type === "dev");
      }

      console.log(`📦 Installed packages (${filtered.length}):\n`);

      const prodPackages = filtered.filter(p => p.type === "prod");
      const devPackages = filtered.filter(p => p.type === "dev");

      if (prodPackages.length > 0 && !opts.dev) {
        console.log("Production dependencies:");
        for (const pkg of prodPackages) {
          console.log(`  ${pkg.name}@${pkg.version}`);
        }
        console.log();
      }

      if (devPackages.length > 0 && !opts.prod) {
        console.log("Dev dependencies:");
        for (const pkg of devPackages) {
          console.log(`  ${pkg.name}@${pkg.version}`);
        }
      }
    } catch (error) {
      console.error(`❌ Failed to list packages: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// --- channel ---
const channel = program
  .command("channel")
  .description("Update channel management");

channel
  .command("show")
  .alias("")
  .description("Show current channel and version")
  .action(async () => {
    const root = program.opts()["root"] as string;

    try {
      const currentChannel = await getChannel(root);
      console.log(`📡 Current channel: ${currentChannel}\n`);

      // Try to get current version from config
      const configPath = join(root, ".aof", "channel.json");
      try {
        const content = await readFile(configPath, "utf-8");
        const config = JSON.parse(content);
        if (config.version) {
          console.log(`   Version: ${config.version}`);
        }
        if (config.lastCheck) {
          const lastCheck = new Date(config.lastCheck);
          console.log(`   Last update check: ${lastCheck.toLocaleString()}`);
        }
      } catch {
        // No version info available
      }

      console.log(`\n💡 Available channels: stable, beta, canary`);
    } catch (error) {
      console.error(`❌ Failed to get channel: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

channel
  .command("set <name>")
  .description("Switch to a different channel (stable/beta/canary)")
  .action(async (name: string) => {
    const root = program.opts()["root"] as string;

    try {
      await setChannel(root, name as "stable" | "beta" | "canary");
      console.log(`✅ Channel switched to: ${name}`);
      console.log(`   Run 'aof channel check' to see available updates`);
    } catch (error) {
      console.error(`❌ Failed to set channel: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

channel
  .command("check")
  .description("Check for updates on current channel")
  .option("--force", "Force check even if checked recently", false)
  .action(async (opts: { force: boolean }) => {
    const root = program.opts()["root"] as string;

    console.log("🔍 Checking for updates...\n");

    try {
      const result = await checkForUpdates(root, { force: opts.force });

      if (result.skipped) {
        console.log(`ℹ️  Skipped: ${result.reason}`);
        console.log(`   Use --force to check anyway`);
        return;
      }

      if (result.updateAvailable) {
        console.log(`🎉 Update available!`);
        console.log(`   Current: ${result.currentVersion}`);
        console.log(`   Latest: ${result.latestVersion}`);
        if (result.manifest?.changelog) {
          console.log(`\n📝 Changelog:\n${result.manifest.changelog.split("\n").slice(0, 5).join("\n")}`);
        }
      } else {
        console.log(`✅ You're up to date!`);
        if (result.currentVersion) {
          console.log(`   Version: ${result.currentVersion}`);
        }
      }
    } catch (error) {
      console.error(`❌ Failed to check for updates: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

channel
  .command("info <name>")
  .description("Show version info for a channel")
  .action(async (name: string) => {
    console.log(`📡 Fetching info for channel: ${name}\n`);

    try {
      const manifest = await getVersionManifest(name as "stable" | "beta" | "canary");
      console.log(`   Channel: ${manifest.channel}`);
      console.log(`   Version: ${manifest.version}`);
      console.log(`   Published: ${new Date(manifest.publishedAt).toLocaleString()}`);
      if (manifest.changelog) {
        console.log(`\n📝 Changelog:\n${manifest.changelog.split("\n").slice(0, 10).join("\n")}`);
      }
    } catch (error) {
      console.error(`❌ Failed to fetch channel info: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// --- update ---
program
  .command("update")
  .description("Update AOF to latest version")
  .option("--channel <name>", "Switch channel and update (stable/beta/canary)")
  .option("--rollback", "Rollback to previous version", false)
  .option("--backup <path>", "Backup path for rollback")
  .option("--yes", "Skip confirmation prompt", false)
  .action(async (opts: { channel?: string; rollback: boolean; backup?: string; yes: boolean }) => {
    const root = program.opts()["root"] as string;

    try {
      // Handle rollback
      if (opts.rollback) {
        if (!opts.backup) {
          console.error("❌ --backup path required for rollback");
          process.exitCode = 1;
          return;
        }

        console.log("🔄 Rolling back to previous version...\n");

        const result = await rollbackUpdate({
          aofRoot: root,
          backupPath: opts.backup,
          preservePaths: ["config", "data", "tasks", "events"],
        });

        console.log(`✅ Rollback successful!`);
        console.log(`   Restored version: ${result.restoredVersion}`);
        return;
      }

      // Handle channel switch
      if (opts.channel) {
        console.log(`🔄 Switching to ${opts.channel} channel...\n`);
        await setChannel(root, opts.channel as "stable" | "beta" | "canary");
      }

      // Check for updates
      console.log("🔍 Checking for updates...\n");
      const updateCheck = await checkForUpdates(root, { force: true });

      if (!updateCheck.updateAvailable) {
        console.log("✅ Already on latest version");
        if (updateCheck.currentVersion) {
          console.log(`   Version: ${updateCheck.currentVersion}`);
        }
        return;
      }

      // Show update info
      console.log(`🎉 Update available!`);
      console.log(`   Current: ${updateCheck.currentVersion}`);
      console.log(`   Latest: ${updateCheck.latestVersion}`);

      if (updateCheck.manifest?.changelog) {
        console.log(`\n📝 Changelog:\n${updateCheck.manifest.changelog.split("\n").slice(0, 10).join("\n")}`);
      }

      // Confirm update
      if (!opts.yes) {
        console.log("\n⚠️  This will update your AOF installation.");
        console.log("   Config and data will be preserved.");
        console.log("   A backup will be created for rollback.\n");
        console.log("Run with --yes to skip this prompt.");
        return;
      }

      // Perform update
      console.log("\n🚀 Updating AOF...");

      const downloadUrl = `https://github.com/aof/aof/releases/download/v${updateCheck.latestVersion}/aof-${updateCheck.latestVersion}.tar.gz`;

      const result = await selfUpdate({
        aofRoot: root,
        targetVersion: updateCheck.latestVersion!,
        downloadUrl,
        preservePaths: ["config", "data", "tasks", "events"],
        healthCheck: async (installRoot: string) => {
          // Basic health check: verify key directories exist
          const { access } = await import("node:fs/promises");
          try {
            await access(join(installRoot, "package.json"));
            return true;
          } catch {
            return false;
          }
        },
        hooks: {
          preUpdate: async (ctx) => {
            console.log(`   📦 Backing up current version (${ctx.currentVersion})...`);
          },
          postUpdate: async (ctx) => {
            console.log(`   ⚡ Running migrations...`);
            // Run any necessary migrations
            // In a real implementation, load migrations from a registry
            await runMigrations({
              aofRoot: root,
              migrations: [], // Load from registry
              targetVersion: ctx.currentVersion,
            });
          },
        },
      });

      console.log(`\n✅ Update successful!`);
      console.log(`   Version: ${result.version}`);
      console.log(`   Backup: ${result.backupPath}`);
      console.log(`\n💡 To rollback: aof update --rollback --backup ${result.backupPath}`);
    } catch (error) {
      console.error(`❌ Update failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// --- migrate-to-projects ---
program
  .command("migrate-to-projects")
  .description("Migrate legacy vault layout to Projects v0 (_inbox)")
  .option("--dry-run", "Report planned actions without making changes", false)
  .action(async (opts: { dryRun: boolean }) => {
    const root = program.opts()["root"] as string;

    console.log("🔄 Migrating to Projects v0 layout...\n");

    if (opts.dryRun) {
      console.log("   [DRY RUN MODE - no changes will be made]\n");
    }

    try {
      const result = await migrateToProjects(root, { dryRun: opts.dryRun });

      if (result.warnings.length > 0) {
        console.log("ℹ️  Migration status:");
        for (const warning of result.warnings) {
          console.log(`   • ${warning}`);
        }
        return;
      }

      console.log("✅ Migration complete!\n");
      console.log(`   Backup: ${result.backupPath}`);
      console.log(`   Migrated directories: ${result.migratedDirs.join(", ")}`);
      console.log(`   Updated tasks: ${result.updatedTaskCount}`);
      console.log(`   Skipped files: ${result.skippedTaskCount}`);

      console.log("\n💡 Next steps:");
      console.log("   1. Verify migrated tasks in Projects/_inbox/tasks/");
      console.log("   2. Test your workflows with the new layout");
      console.log(`   3. If needed, rollback with: aof rollback-migration`);
    } catch (error) {
      console.error(`❌ Migration failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// --- rollback-migration ---
program
  .command("rollback-migration")
  .description("Rollback Projects v0 migration and restore legacy layout")
  .option("--dry-run", "Report planned actions without making changes", false)
  .option("--backup <dir>", "Explicit backup directory to restore from (default: latest tasks.backup-*)")
  .action(async (opts: { dryRun: boolean; backup?: string }) => {
    const root = program.opts()["root"] as string;

    console.log("🔙 Rolling back migration...\n");

    if (opts.dryRun) {
      console.log("   [DRY RUN MODE - no changes will be made]\n");
    }

    try {
      const result = await rollbackMigration(root, {
        dryRun: opts.dryRun,
        backupDir: opts.backup,
      });

      console.log("✅ Rollback complete!\n");
      console.log(`   Restored directories: ${result.restoredDirs.join(", ")}`);

      if (result.warnings.length > 0) {
        console.log("\n⚠️  Warnings:");
        for (const warning of result.warnings) {
          console.log(`   • ${warning}`);
        }
      }

      console.log("\n💡 Next steps:");
      console.log("   1. Verify legacy tasks/ directory restored");
      console.log("   2. Resume normal operations with legacy layout");
    } catch (error) {
      console.error(`❌ Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
