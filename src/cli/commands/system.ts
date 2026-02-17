/**
 * System commands — config, metrics, notifications, install, deps, channel, update.
 * 
 * Implements system-level CLI commands for configuration management,
 * metrics collection, notification testing, package management, and updates.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { getConfigValue, setConfigValue, validateConfig } from "../../config/index.js";

/**
 * Register all system-related commands with the Commander program.
 */
export function registerSystemCommands(program: Command): void {
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
}
