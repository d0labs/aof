/**
 * AOF Init — OpenClaw Integration Wizard
 *
 * Registers AOF as an OpenClaw plugin, optionally sets up the memory system,
 * and installs the companion skill. All config changes go through
 * `openclaw config set` — NEVER edits openclaw.json directly.
 */

import { confirm, select } from "@inquirer/prompts";
import type { Command } from "commander";
import { mkdir, copyFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  detectOpenClaw,
  isAofPluginRegistered,
  isAofInAllowList,
  registerAofPlugin,
  addAofToAllowList,
  detectMemoryPlugin,
  configureAofAsMemoryPlugin,
  isAofMemoryEnabled,
  isAofMemorySlot,
} from "../packaging/openclaw-cli.js";
import { runSyncStep } from "./init-sync.js";

/** Path to this compiled file's directory (dist/cli/) at runtime. */
const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

/** Root of the AOF package (two levels up from dist/cli/). */
const PKG_ROOT = resolve(__dir, "..", "..");

export interface InitOptions {
  /** Non-interactive mode — use defaults, skip all prompts. */
  yes?: boolean;
  /** Skip OpenClaw integration steps. */
  skipOpenclaw?: boolean;
}

interface WizardState {
  pluginRegistered: boolean;
  addedToAllowList: boolean;
  syncCompleted: boolean;
  memoryConfigured: boolean;
  skillInstalled: boolean;
  warnings: string[];
  skipped: string[];
}

/**
 * Main entry point for `aof init`.
 */
export async function init(opts: InitOptions = {}): Promise<void> {
  const { yes = false, skipOpenclaw = false } = opts;

  console.log("\n🚀 AOF Integration Wizard\n");
  console.log("This wizard will register AOF with OpenClaw, optionally");
  console.log("configure the memory system, and install the companion skill.\n");

  const state: WizardState = {
    pluginRegistered: false,
    addedToAllowList: false,
    syncCompleted: false,
    memoryConfigured: false,
    skillInstalled: false,
    warnings: [],
    skipped: [],
  };

  if (skipOpenclaw) {
    console.log("⏭  Skipping OpenClaw integration (--skip-openclaw).\n");
    await runSkillStep(state, yes);
    printSummary(state, null);
    return;
  }

  // Step 1: Detect OpenClaw
  console.log("🔍 Detecting OpenClaw installation...");
  const detection = await detectOpenClaw();

  if (!detection.detected || !detection.configPath) {
    console.log("⚠️  OpenClaw not detected (config not found at ~/.openclaw/openclaw.json).");
    console.log("   Install OpenClaw first, or run with --skip-openclaw for standalone setup.\n");
    await runSkillStep(state, yes);
    printSummary(state, null);
    return;
  }

  console.log(`✅ OpenClaw detected${detection.version ? ` (${detection.version})` : ""}.\n`);

  // Step 2: Plugin registration
  await runPluginStep(state, yes);

  // Step 2.5: Org chart ↔ OpenClaw agent sync
  const orgChartPath = join(process.cwd(), "org", "org-chart.yaml");
  try {
    const syncResult = await runSyncStep(orgChartPath, yes);
    state.syncCompleted = syncResult.imported.length > 0 || syncResult.exported.length > 0;
    state.warnings.push(...syncResult.warnings);
  } catch {
    state.warnings.push("Org chart sync failed — run `aof org drift` manually.");
  }

  // Step 3: Memory system
  await runMemoryStep(state, yes);

  // Step 4: Companion skill
  await runSkillStep(state, yes);

  // Summary
  printSummary(state, detection.configPath);
}

/**
 * Register the `init` command with the CLI.
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Interactive AOF + OpenClaw integration wizard")
    .option("--yes", "Run non-interactively with defaults")
    .option("--skip-openclaw", "Skip OpenClaw integration steps")
    .action(async (opts: InitOptions) => {
      await init(opts);
    });
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

async function runPluginStep(state: WizardState, yes: boolean): Promise<void> {
  const alreadyRegistered = await isAofPluginRegistered();
  const inAllowList = await isAofInAllowList();

  if (alreadyRegistered && inAllowList) {
    console.log("✅ AOF plugin already registered and in allow list — skipping.\n");
    state.pluginRegistered = true;
    state.addedToAllowList = true;
    state.skipped.push("Plugin registration (already configured)");
    return;
  }

  const pluginJsonPath = join(PKG_ROOT, "openclaw.plugin.json");

  if (!alreadyRegistered) {
    const doRegister =
      yes ||
      (await confirm({
        message: "Register AOF as an OpenClaw plugin?",
        default: true,
      }));

    if (doRegister) {
      console.log("  Registering AOF plugin...");
      try {
        await registerAofPlugin(pluginJsonPath);
        state.pluginRegistered = true;
        state.addedToAllowList = true;
        console.log("  ✅ Plugin registered and added to allow list.\n");
      } catch (err) {
        state.warnings.push(
          `Plugin registration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.log(`  ❌ Registration failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    } else {
      state.skipped.push("Plugin registration");
    }
  } else if (!inAllowList) {
    // Registered but not in allow list — add silently
    console.log("  Plugin registered but not in allow list — adding...");
    try {
      await addAofToAllowList();
      state.addedToAllowList = true;
      console.log("  ✅ Added to allow list.\n");
    } catch (err) {
      state.warnings.push(
        `Failed to add AOF to allow list: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function runMemoryStep(state: WizardState, yes: boolean): Promise<void> {
  // Check current state
  const alreadyMemory = (await isAofMemorySlot()) && (await isAofMemoryEnabled());
  if (alreadyMemory) {
    console.log("✅ AOF memory system already configured — skipping.\n");
    state.memoryConfigured = true;
    state.skipped.push("Memory configuration (already active)");
    return;
  }

  const wantMemory =
    yes ||
    (await confirm({
      message: "Would you like to use AOF's built-in memory system?",
      default: false,
    }));

  if (!wantMemory) {
    state.skipped.push("Memory system");
    console.log();
    return;
  }

  // Detect current memory plugin
  const { slotHolder, candidates } = await detectMemoryPlugin();
  const currentPlugin = slotHolder ?? candidates[0];

  if (currentPlugin) {
    console.log(`\n  ⚠️  Current memory plugin: ${currentPlugin}`);
    console.log(`  Enabling AOF memory will disable "${currentPlugin}" as the memory provider.`);

    const confirmed =
      yes ||
      (await confirm({
        message: `Disable "${currentPlugin}" and enable AOF memory?`,
        default: false,
      }));

    if (!confirmed) {
      state.skipped.push("Memory system (user declined)");
      console.log();
      return;
    }
  }

  console.log("  Configuring AOF memory system...");
  try {
    await configureAofAsMemoryPlugin(currentPlugin);
    state.memoryConfigured = true;
    if (currentPlugin) {
      console.log(`  ✅ "${currentPlugin}" disabled.`);
    }
    console.log("  ✅ AOF set as memory provider (slots.memory = aof).\n");
    state.warnings.push("Restart the OpenClaw gateway to activate memory changes.");
  } catch (err) {
    state.warnings.push(
      `Memory configuration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(`  ❌ Memory config failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function runSkillStep(state: WizardState, yes: boolean): Promise<void> {
  const skillDest = join(homedir(), ".openclaw", "skills", "aof", "SKILL.md");
  const skillSrc = join(PKG_ROOT, "skills", "aof", "SKILL.md");

  // Verify bundled skill exists
  try {
    await access(skillSrc);
  } catch {
    state.warnings.push("Bundled skill not found in package — skipping skill install.");
    return;
  }

  // Check if already installed
  try {
    await access(skillDest);
    console.log("✅ AOF companion skill already installed — skipping.\n");
    state.skillInstalled = true;
    state.skipped.push("Companion skill (already installed)");
    return;
  } catch {
    // Not installed yet
  }

  const installSkill =
    yes ||
    (await confirm({
      message: "Install the AOF companion skill for your AI agents?",
      default: true,
    }));

  if (!installSkill) {
    state.skipped.push("Companion skill");
    console.log();
    return;
  }

  console.log("  Installing companion skill...");
  try {
    await mkdir(dirname(skillDest), { recursive: true });
    await copyFile(skillSrc, skillDest);
    state.skillInstalled = true;
    console.log(`  ✅ Skill installed at ${skillDest}\n`);
  } catch (err) {
    state.warnings.push(
      `Skill installation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(`  ❌ Skill install failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(state: WizardState, configPath: string | null | undefined): void {
  console.log("─".repeat(60));
  console.log("📋 Summary\n");

  const done: string[] = [];
  if (state.pluginRegistered) done.push("✅ AOF plugin registered");
  if (state.addedToAllowList) done.push("✅ Added to allow list");
  if (state.syncCompleted) done.push("✅ Org chart synced with OpenClaw agents");
  if (state.memoryConfigured) done.push("✅ Memory system configured");
  if (state.skillInstalled) done.push("✅ Companion skill installed");

  for (const item of done) console.log(`  ${item}`);
  for (const item of state.skipped) console.log(`  ⏭  ${item}`);

  if (state.warnings.length > 0) {
    console.log("\n⚠️  Warnings:");
    for (const w of state.warnings) console.log(`  - ${w}`);
  }

  const hasGatewayWork = state.pluginRegistered || state.memoryConfigured;
  const anythingDone = done.length > 0;

  if (hasGatewayWork) {
    console.log("\n🔄 Next step: restart the OpenClaw gateway to activate changes.");
    console.log("   Run: openclaw gateway restart");
  }

  if (!anythingDone && state.skipped.length === 0 && state.warnings.length === 0) {
    console.log("  (nothing to do)");
  }

  console.log();
}
