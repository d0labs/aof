/**
 * Configuration, metrics, and notification commands.
 */

import { join } from "node:path";
import type { Command } from "commander";
import { getConfigValue, setConfigValue, validateConfig } from "../../config/index.js";
import { startMetricsServer, AOFMetrics } from "../../metrics/exporter.js";
import { collectMetrics } from "../../metrics/collector.js";
import { NotificationService, MockNotificationAdapter } from "../../events/notifier.js";
import type { BaseEvent } from "../../schemas/event.js";

/**
 * Register configuration management commands.
 */
export function registerConfigCommands(program: Command): void {
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
}

/**
 * Register metrics commands.
 */
export function registerMetricsCommands(program: Command): void {
  const metrics = program
    .command("metrics")
    .description("Metrics and observability");

  metrics
    .command("serve")
    .description("Start Prometheus metrics HTTP server")
    .option("-p, --port <port>", "HTTP port", "9090")
    .option("--project <id>", "Project ID", "_inbox")
    .action(async (opts: { port: string; project: string }) => {
      const { createProjectStore } = await import("../project-utils.js");
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
}

/**
 * Register notification testing commands.
 */
export function registerNotificationsCommands(program: Command): void {
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
}
