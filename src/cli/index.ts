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
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerTaskCommands } from "./commands/task.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerOrgCommands } from "./commands/org.js";
import { registerViewCommands } from "./commands/views.js";

const AOF_ROOT = process.env["AOF_ROOT"] ?? resolve(homedir(), "Projects", "AOF");

const program = new Command()
  .name("aof")
  .version("0.1.0")
  .description("Agentic Ops Fabric — deterministic orchestration for multi-agent systems")
  .option("--root <path>", "AOF root directory", AOF_ROOT);


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
registerTaskCommands(program);

// --- org ---
registerOrgCommands(program);

// --- views ---
registerViewCommands(program);

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
registerMemoryCommands(program);


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

  console.error(err);
  process.exitCode = 1;
});
