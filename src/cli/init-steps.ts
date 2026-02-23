/**
 * AOF Init — Wizard step implementations.
 *
 * Extracted from init.ts to keep the orchestrator lean.
 * Import: runPluginStep, runMemoryStep, runSkillStep, runSkillWiringStep, runQmdStep.
 */

import { confirm } from "@inquirer/prompts";
import { mkdir, copyFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  isAofPluginRegistered,
  isAofInAllowList,
  registerAofPlugin,
  addAofToAllowList,
  detectMemoryPlugin,
  configureAofAsMemoryPlugin,
  isAofMemoryEnabled,
  isAofMemorySlot,
  openclawConfigGet,
  openclawConfigSet,
} from "../packaging/openclaw-cli.js";

/** Path to this compiled file's directory (dist/cli/) at runtime. */
const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

/** Root of the AOF package (two levels up from dist/cli/). */
const PKG_ROOT = resolve(__dir, "..", "..");

// ---------------------------------------------------------------------------
// Shared WizardState — imported here so steps can mutate it
// ---------------------------------------------------------------------------

export interface WizardState {
  pluginRegistered: boolean;
  addedToAllowList: boolean;
  syncCompleted: boolean;
  memoryConfigured: boolean;
  skillInstalled: boolean;
  skillsWired: boolean;
  warnings: string[];
  skipped: string[];
}

export function makeInitialState(): WizardState {
  return {
    pluginRegistered: false,
    addedToAllowList: false,
    syncCompleted: false,
    memoryConfigured: false,
    skillInstalled: false,
    skillsWired: false,
    warnings: [],
    skipped: [],
  };
}

// ---------------------------------------------------------------------------
// Step 2: Plugin registration
// ---------------------------------------------------------------------------

export async function runPluginStep(state: WizardState, yes: boolean): Promise<void> {
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

// ---------------------------------------------------------------------------
// Step 3: Memory system
// ---------------------------------------------------------------------------

export async function runMemoryStep(state: WizardState, yes: boolean): Promise<void> {
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
    // Gap #4: disable qmd boot indexing now that AOF owns memory
    await runQmdStep(state, yes);
  } catch (err) {
    state.warnings.push(
      `Memory configuration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(`  ❌ Memory config failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Step 3a: qmd dual-indexer guard (called from runMemoryStep on success)
// ---------------------------------------------------------------------------

export async function runQmdStep(state: WizardState, yes: boolean): Promise<void> {
  const onBoot = await openclawConfigGet("memory.qmd.update.onBoot");
  if (onBoot !== true) return;

  console.log("  ⚠️  qmd memory indexer is configured to run on boot.");
  console.log("  Running qmd alongside AOF memory causes duplicate indexing.");

  const doDisable =
    yes ||
    (await confirm({
      message: "Disable qmd boot indexing to avoid conflict with AOF memory?",
      default: true,
    }));

  if (!doDisable) {
    state.warnings.push(
      "qmd boot indexing still enabled — may conflict with AOF memory provider.",
    );
    console.log();
    return;
  }

  try {
    await openclawConfigSet("memory.qmd.update.onBoot", false);
    console.log("  ✅ qmd boot indexing disabled.\n");
  } catch (err) {
    state.warnings.push(
      `Failed to disable qmd boot indexing: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(
      `  ❌ Failed to disable qmd: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Step 4: Companion skill (file install)
// ---------------------------------------------------------------------------

export async function runSkillStep(state: WizardState, yes: boolean): Promise<void> {
  const skillDest = join(homedir(), ".openclaw", "skills", "aof", "SKILL.md");
  const skillSrc = join(PKG_ROOT, "skills", "aof", "SKILL.md");

  try {
    await access(skillSrc);
  } catch {
    state.warnings.push("Bundled skill not found in package — skipping skill install.");
    return;
  }

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
// Step 5: Wire 'aof' skill to all agents in openclaw.json  (Gap #3)
// ---------------------------------------------------------------------------

export async function runSkillWiringStep(state: WizardState, yes: boolean): Promise<void> {
  console.log("🔌 Wiring AOF skill to agents...");

  const agentList = (await openclawConfigGet("agents.list")) as
    | Array<{ id?: string; skills?: string[] }>
    | undefined;

  if (!Array.isArray(agentList) || agentList.length === 0) {
    console.log("  No agents found — skipping.\n");
    state.skipped.push("Skill wiring (no agents configured)");
    return;
  }

  const needsWiring = agentList.filter(
    (a) => !Array.isArray(a.skills) || !a.skills.includes("aof"),
  );

  if (needsWiring.length === 0) {
    console.log("✅ AOF skill already wired to all agents — skipping.\n");
    state.skipped.push("Skill wiring (already configured)");
    return;
  }

  const ids = needsWiring.map((a) => a.id ?? "(unnamed)").join(", ");
  console.log(`  ${needsWiring.length} agent(s) missing 'aof' skill: ${ids}`);

  const doWire =
    yes ||
    (await confirm({
      message: `Add 'aof' skill to ${needsWiring.length} agent(s)?`,
      default: true,
    }));

  if (!doWire) {
    state.skipped.push("Skill wiring (user declined)");
    console.log();
    return;
  }

  const updated = agentList.map((agent) => {
    if (Array.isArray(agent.skills) && !agent.skills.includes("aof")) {
      return { ...agent, skills: [...agent.skills, "aof"] };
    }
    if (!Array.isArray(agent.skills)) {
      return { ...agent, skills: ["aof"] };
    }
    return agent;
  });

  try {
    await openclawConfigSet("agents.list", updated);
    state.skillsWired = true;
    console.log(`  ✅ 'aof' skill added to ${needsWiring.length} agent(s).\n`);
  } catch (err) {
    const msg = `Skill wiring failed: ${err instanceof Error ? err.message : String(err)}`;
    state.warnings.push(msg);
    console.log(`  ❌ ${msg}\n`);
  }
}
