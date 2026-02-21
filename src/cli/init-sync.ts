/**
 * Init Sync Step — Bidirectional org chart ↔ OpenClaw agent sync.
 *
 * Step 2.5 of the `aof init` wizard:
 * 1. Import: OpenClaw agents → org chart (add missing entries)
 * 2. Export: org chart agents → OpenClaw config (register missing agents)
 * 3. Drift report: show remaining mismatches
 */

import { confirm, checkbox } from "@inquirer/prompts";
import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { OrgChart, type OrgAgent } from "../schemas/org-chart.js";
import { openclawConfigGet, openclawConfigSet } from "../packaging/openclaw-cli.js";
import { detectDrift, type OpenClawAgent } from "../drift/detector.js";
import { formatDriftReport } from "../drift/formatter.js";
import { LiveAdapter } from "../drift/adapters.js";

export interface SyncResult {
  imported: string[];
  exported: string[];
  driftReported: boolean;
  warnings: string[];
}

/**
 * Fetch OpenClaw agents from `openclaw agents list --json`.
 */
async function fetchOpenClawAgents(): Promise<OpenClawAgent[]> {
  try {
    const adapter = new LiveAdapter();
    return await adapter.getAgents();
  } catch {
    return [];
  }
}

/**
 * Load org chart from the standard location. Returns null if not found.
 */
async function loadOrgChartRaw(orgChartPath: string): Promise<{
  raw: Record<string, unknown>;
  parsed: ReturnType<typeof OrgChart.parse>;
} | null> {
  try {
    await access(orgChartPath);
    const content = await readFile(orgChartPath, "utf-8");
    const raw = parseYaml(content) as Record<string, unknown>;
    const result = OrgChart.safeParse(raw);
    if (!result.success) return null;
    return { raw, parsed: result.data };
  } catch {
    return null;
  }
}

/**
 * Write org chart YAML atomically.
 */
async function writeOrgChart(orgChartPath: string, raw: Record<string, unknown>): Promise<void> {
  const tmpPath = join(dirname(orgChartPath), `.org-chart.tmp.${randomUUID().slice(0, 8)}.yaml`);
  const content = stringifyYaml(raw, { lineWidth: 120 });
  await writeFile(tmpPath, content, "utf-8");
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, orgChartPath);
}

/**
 * Infer a reasonable OrgAgent entry from an OpenClaw agent.
 */
function inferOrgAgent(oc: OpenClawAgent): {
  id: string;
  openclawAgentId: string;
  name: string;
  description: string;
  active: boolean;
  capabilities: { tags: string[]; concurrency: number };
  comms: { preferred: string; fallbacks: string[] };
} {
  // Derive a short ID from the OpenClaw agent ID
  // OpenClaw IDs look like "agent:main:main" or "swe-backend"
  const parts = oc.id.split(":");
  const shortId = parts[parts.length - 1] || oc.id;

  return {
    id: shortId,
    openclawAgentId: oc.id,
    name: oc.name,
    description: `Imported from OpenClaw (${oc.creature || "agent"})`,
    active: oc.active,
    capabilities: { tags: [], concurrency: 1 },
    comms: { preferred: "send", fallbacks: ["send", "cli"] },
  };
}

/**
 * Run the bidirectional sync step in the init wizard.
 */
export async function runSyncStep(
  orgChartPath: string,
  yes: boolean,
): Promise<SyncResult> {
  const result: SyncResult = {
    imported: [],
    exported: [],
    driftReported: false,
    warnings: [],
  };

  console.log("🔄 Syncing org chart with OpenClaw agents...\n");

  // Load both sides
  const openclawAgents = await fetchOpenClawAgents();
  if (openclawAgents.length === 0) {
    console.log("  No OpenClaw agents found — skipping sync.\n");
    return result;
  }

  const orgData = await loadOrgChartRaw(orgChartPath);
  if (!orgData) {
    console.log(`  No valid org chart found at ${orgChartPath} — skipping sync.\n`);
    result.warnings.push("Org chart not found or invalid; sync skipped.");
    return result;
  }

  const { raw, parsed: orgChart } = orgData;

  // Build lookup: openclawAgentId → org agent
  const orgByOpenClawId = new Map<string, OrgAgent>();
  const orgByShortId = new Map<string, OrgAgent>();
  for (const agent of orgChart.agents) {
    if (agent.openclawAgentId) {
      orgByOpenClawId.set(agent.openclawAgentId, agent);
    }
    orgByShortId.set(agent.id, agent);
  }

  // ── Phase 1: Import (OpenClaw → Org Chart) ──────────────────────────

  const newAgents: OpenClawAgent[] = [];
  for (const oc of openclawAgents) {
    if (!oc.active) continue;
    // Check both openclawAgentId and short ID match
    if (orgByOpenClawId.has(oc.id)) continue;
    const parts = oc.id.split(":");
    const shortId = parts[parts.length - 1] || oc.id;
    if (orgByShortId.has(shortId)) continue;
    newAgents.push(oc);
  }

  if (newAgents.length > 0) {
    console.log(`  Found ${newAgents.length} OpenClaw agent(s) not in org chart:\n`);
    for (const a of newAgents) {
      console.log(`    • ${a.id} (${a.name})`);
    }
    console.log();

    let toImport: OpenClawAgent[];
    if (yes) {
      toImport = newAgents;
    } else {
      const selected = await checkbox({
        message: "Select agents to add to org chart:",
        choices: newAgents.map((a) => ({
          name: `${a.id} (${a.name})`,
          value: a.id,
          checked: true,
        })),
      });
      toImport = newAgents.filter((a) => selected.includes(a.id));
    }

    if (toImport.length > 0) {
      const agents = (raw as { agents?: unknown[] }).agents ?? [];
      for (const oc of toImport) {
        agents.push(inferOrgAgent(oc));
        result.imported.push(oc.id);
      }
      (raw as { agents: unknown[] }).agents = agents;
      await writeOrgChart(orgChartPath, raw);
      console.log(`  ✅ Added ${toImport.length} agent(s) to org chart.\n`);
    }
  } else {
    console.log("  ✅ All OpenClaw agents already in org chart.\n");
  }

  // ── Phase 2: Export (Org Chart → OpenClaw) ───────────────────────────

  const openclawIds = new Set(openclawAgents.map((a) => a.id));
  const orgOnlyAgents = orgChart.agents.filter((a) => {
    if (!a.openclawAgentId) return false;
    return !openclawIds.has(a.openclawAgentId);
  });

  if (orgOnlyAgents.length > 0) {
    console.log(`  Found ${orgOnlyAgents.length} org chart agent(s) not in OpenClaw:\n`);
    for (const a of orgOnlyAgents) {
      console.log(`    • ${a.id} → ${a.openclawAgentId}`);
    }
    console.log();

    let toExport: OrgAgent[];
    if (yes) {
      toExport = orgOnlyAgents;
    } else {
      const selected = await checkbox({
        message: "Select agents to register in OpenClaw:",
        choices: orgOnlyAgents.map((a) => ({
          name: `${a.id} (${a.openclawAgentId})`,
          value: a.id,
          checked: true,
        })),
      });
      toExport = orgOnlyAgents.filter((a) => selected.includes(a.id));
    }

    for (const agent of toExport) {
      try {
        await openclawConfigSet(`agents.${agent.openclawAgentId}`, {
          name: agent.name,
          active: agent.active,
        });
        result.exported.push(agent.id);
      } catch (err) {
        const msg = `Failed to register ${agent.id}: ${err instanceof Error ? err.message : String(err)}`;
        result.warnings.push(msg);
        console.log(`  ⚠️  ${msg}`);
      }
    }

    if (result.exported.length > 0) {
      console.log(`  ✅ Registered ${result.exported.length} agent(s) in OpenClaw.\n`);
    }
  } else {
    console.log("  ✅ All org chart agents present in OpenClaw.\n");
  }

  // ── Phase 3: Drift Report ────────────────────────────────────────────

  // Re-load org chart (may have been modified by import)
  const updatedOrg = await loadOrgChartRaw(orgChartPath);
  const finalAgents = await fetchOpenClawAgents();

  if (updatedOrg && finalAgents.length > 0) {
    const report = detectDrift(updatedOrg.parsed, finalAgents);
    result.driftReported = true;

    if (report.summary.hasDrift) {
      console.log("  " + formatDriftReport(report).split("\n").join("\n  "));
      console.log();
    } else {
      console.log("  ✅ No drift — org chart and OpenClaw are in sync.\n");
    }
  }

  return result;
}
