/**
 * Project management CLI commands.
 * Registers project lifecycle commands (init, create-project, integrate, eject, migrations).
 */

import { join, homedir } from "node:path";
import type { Command } from "commander";
import { init } from "../init.js";
import { integrateWithOpenClaw, detectOpenClawConfig } from "../../packaging/integration.js";
import { ejectFromOpenClaw, detectOpenClawIntegration } from "../../packaging/ejector.js";
import { migrateToProjects, rollbackMigration } from "../../projects/migration.js";

/**
 * Register project commands with the CLI program.
 */
export function registerProjectCommands(program: Command): void {
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
      const { createProject } = await import("../../projects/create.js");
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

  // --- migrate-to-projects ---
  program
    .command("migrate-to-projects")
    .description("Migrate tasks/ layout to Projects/ layout (v0 to v0.1)")
    .option("--dry-run", "Report planned actions without making changes", false)
    .option("--skip-backup", "Skip pre-migration backup (NOT recommended)", false)
    .action(async (opts: { dryRun: boolean; skipBackup: boolean }) => {
      const root = program.opts()["root"] as string;

      console.log("🔄 Starting Projects v0 migration...\n");

      if (opts.dryRun) {
        console.log("   [DRY RUN MODE - no changes will be made]\n");
      }

      if (opts.skipBackup && !opts.dryRun) {
        console.warn("⚠️  WARNING: Running without backup. Recovery will be difficult if issues occur.\n");
      }

      try {
        const result = await migrateToProjects(root, {
          dryRun: opts.dryRun,
          backup: !opts.skipBackup,
        });

        console.log("✅ Migration complete!\n");
        console.log(`   Tasks migrated: ${result.tasksMigrated}`);
        console.log(`   Projects created: ${result.projectsCreated.join(", ")}`);
        if (result.backupCreated) {
          console.log(`   Backup created: ${result.backupPath}`);
        }

        if (result.warnings.length > 0) {
          console.log("\n⚠️  Warnings:");
          for (const warning of result.warnings) {
            console.log(`   • ${warning}`);
          }
        }

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
}
