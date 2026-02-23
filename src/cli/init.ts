/**
 * AOF Init — OpenClaw Integration Wizard (orchestrator).
 *
 * Step implementations live in init-steps.ts.
 * All config changes go through `openclaw config set` — NEVER edits openclaw.json directly.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { detectOpenClaw } from "../packaging/openclaw-cli.js";
import { runSyncStep } from "./init-sync.js";
import {
  makeInitialState,
  runPluginStep,
  runMemoryStep,
  runSkillStep,
  runSkillWiringStep,
} from "./init-steps.js";
import type { WizardState } from "./init-steps.js";

export interface InitOptions {
  /** Non-interactive mode — use defaults, skip all prompts. */
  yes?: boolean;
  /** Skip OpenClaw integration steps. */
  skipOpenclaw?: boolean;
}

/**
 * Main entry point for `aof init`.
 */
export async function init(opts: InitOptions = {}): Promise<void> {
  const { yes = false, skipOpenclaw = false } = opts;

  console.log("\n🚀 AOF Integration Wizard\n");
  console.log("This wizard will register AOF with OpenClaw, optionally");
  console.log("configure the memory system, and install the companion skill.\n");

  const state = makeInitialState();

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

  // Step 3: Memory system (includes qmd dual-indexer check on success)
  await runMemoryStep(state, yes);

  // Step 4: Companion skill file install
  await runSkillStep(state, yes);

  // Step 5: Wire 'aof' skill to all agents in openclaw.json
  await runSkillWiringStep(state, yes);

  // Summary
  printSummary(state, detection.configPath);
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
  if (state.skillsWired) done.push("✅ AOF skill wired to all agents");

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
