/**
 * Org chart linter — referential integrity and policy validation.
 *
 * Goes beyond Zod schema validation to check:
 * - All reportsTo references resolve to existing agents
 * - All team leads exist
 * - No orphaned agents (not in any team)
 * - Routing rules reference valid roles/teams/agents
 * - No circular reporting chains
 * - Active agents have required fields
 */

import type { OrgChart, OrgAgent } from "../schemas/org-chart.js";

export interface LintIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
  path?: string;
}

/**
 * Lint an org chart for referential integrity issues.
 */
export function lintOrgChart(chart: OrgChart): LintIssue[] {
  const issues: LintIssue[] = [];
  const agentIds = new Set(chart.agents.map(a => a.id));
  const teamIds = new Set(chart.teams.map(t => t.id));
  const orgUnitIds = new Set(chart.orgUnits.map(u => u.id));
  const groupIds = new Set(chart.groups.map(g => g.id));

  // Check reportsTo references
  for (const agent of chart.agents) {
    if (agent.reportsTo && !agentIds.has(agent.reportsTo)) {
      issues.push({
        severity: "error",
        rule: "valid-reports-to",
        message: `Agent '${agent.id}' reportsTo '${agent.reportsTo}' which does not exist`,
        path: `agents.${agent.id}.reportsTo`,
      });
    }
  }

  // Check team leads
  for (const team of chart.teams) {
    if (team.lead && !agentIds.has(team.lead)) {
      issues.push({
        severity: "error",
        rule: "valid-team-lead",
        message: `Team '${team.id}' lead '${team.lead}' does not exist as an agent`,
        path: `teams.${team.id}.lead`,
      });
    }
  }

  // Check agent team membership
  for (const agent of chart.agents) {
    if (agent.team && !teamIds.has(agent.team)) {
      issues.push({
        severity: "error",
        rule: "valid-agent-team",
        message: `Agent '${agent.id}' belongs to team '${agent.team}' which does not exist`,
        path: `agents.${agent.id}.team`,
      });
    }
  }

  // Check for orphaned agents (no team, not the root)
  const agentsWithTeams = chart.agents.filter(a => a.team);
  const agentsWithoutTeams = chart.agents.filter(a => !a.team && !a.reportsTo);
  if (agentsWithoutTeams.length > 1) {
    for (const agent of agentsWithoutTeams) {
      issues.push({
        severity: "warning",
        rule: "orphaned-agent",
        message: `Agent '${agent.id}' has no team and no reportsTo (orphaned)`,
        path: `agents.${agent.id}`,
      });
    }
  }

  // Check routing rules reference valid targets
  for (let i = 0; i < chart.routing.length; i++) {
    const rule = chart.routing[i]!;
    if (rule.targetAgent && !agentIds.has(rule.targetAgent)) {
      issues.push({
        severity: "error",
        rule: "valid-routing-target",
        message: `Routing rule ${i} targets agent '${rule.targetAgent}' which does not exist`,
        path: `routing[${i}].targetAgent`,
      });
    }
    if (rule.targetTeam && !teamIds.has(rule.targetTeam)) {
      issues.push({
        severity: "error",
        rule: "valid-routing-target",
        message: `Routing rule ${i} targets team '${rule.targetTeam}' which does not exist`,
        path: `routing[${i}].targetTeam`,
      });
    }
  }

  // Check role mappings reference valid agents
  if (chart.roles) {
    for (const [roleName, role] of Object.entries(chart.roles)) {
      for (const agentId of role.agents) {
        if (!agentIds.has(agentId)) {
          issues.push({
            severity: "error",
            rule: "valid-role-agent",
            message: `Role '${roleName}' references missing agent '${agentId}'`,
            path: `roles.${roleName}.agents`,
          });
        }
      }
    }
  }

  // Check for circular reporting chains
  for (const agent of chart.agents) {
    if (agent.reportsTo) {
      const visited = new Set<string>();
      let current: string | undefined = agent.id;

      while (current) {
        if (visited.has(current)) {
          issues.push({
            severity: "error",
            rule: "no-circular-reports",
            message: `Circular reporting chain detected starting from agent '${agent.id}'`,
            path: `agents.${agent.id}.reportsTo`,
          });
          break;
        }
        visited.add(current);
        const currentAgent = chart.agents.find(a => a.id === current);
        current = currentAgent?.reportsTo;
      }
    }
  }

  // Check for duplicate agent IDs (shouldn't happen with Zod but belt-and-suspenders)
  const seenIds = new Set<string>();
  for (const agent of chart.agents) {
    if (seenIds.has(agent.id)) {
      issues.push({
        severity: "error",
        rule: "unique-agent-id",
        message: `Duplicate agent ID: '${agent.id}'`,
        path: `agents.${agent.id}`,
      });
    }
    seenIds.add(agent.id);
  }

  // Warn about inactive agents with active routing rules targeting them
  const inactiveAgents = new Set(chart.agents.filter(a => !a.active).map(a => a.id));
  for (let i = 0; i < chart.routing.length; i++) {
    const rule = chart.routing[i]!;
    if (rule.targetAgent && inactiveAgents.has(rule.targetAgent)) {
      issues.push({
        severity: "warning",
        rule: "inactive-routing-target",
        message: `Routing rule ${i} targets inactive agent '${rule.targetAgent}'`,
        path: `routing[${i}].targetAgent`,
      });
    }
  }

  // Warn about agents with self-reporting
  for (const agent of chart.agents) {
    if (agent.reportsTo === agent.id) {
      issues.push({
        severity: "error",
        rule: "no-self-report",
        message: `Agent '${agent.id}' reports to itself`,
        path: `agents.${agent.id}.reportsTo`,
      });
    }
  }

  // P1.1: Tree structure validations (single root)
  const rootUnits = chart.orgUnits.filter(u => !u.parentId);
  if (rootUnits.length > 1) {
    issues.push({
      severity: "error",
      rule: "single-root",
      message: `Org chart has ${rootUnits.length} root units, expected 1. Roots: ${rootUnits.map(u => u.id).join(", ")}`,
      path: "orgUnits",
    });
  }

  // P1.1: Validate parentId exists
  for (const unit of chart.orgUnits) {
    if (unit.parentId && !orgUnitIds.has(unit.parentId)) {
      issues.push({
        severity: "error",
        rule: "valid-parent-id",
        message: `Org unit '${unit.id}' has parentId '${unit.parentId}' which does not exist`,
        path: `orgUnits.${unit.id}.parentId`,
      });
    }
  }

  // P1.1: Duplicate org unit IDs
  const seenOrgUnitIds = new Set<string>();
  for (const unit of chart.orgUnits) {
    if (seenOrgUnitIds.has(unit.id)) {
      issues.push({
        severity: "error",
        rule: "unique-org-unit-id",
        message: `Duplicate org unit ID: '${unit.id}'`,
        path: `orgUnits.${unit.id}`,
      });
    }
    seenOrgUnitIds.add(unit.id);
  }

  // P1.1: Duplicate group IDs
  const seenGroupIds = new Set<string>();
  for (const group of chart.groups) {
    if (seenGroupIds.has(group.id)) {
      issues.push({
        severity: "error",
        rule: "unique-group-id",
        message: `Duplicate group ID: '${group.id}'`,
        path: `groups.${group.id}`,
      });
    }
    seenGroupIds.add(group.id);
  }

  // P1.1: Validate membership references
  for (let i = 0; i < chart.memberships.length; i++) {
    const membership = chart.memberships[i]!;
    if (!agentIds.has(membership.agentId)) {
      issues.push({
        severity: "error",
        rule: "valid-membership-agent",
        message: `Membership ${i} references non-existent agent '${membership.agentId}'`,
        path: `memberships[${i}].agentId`,
      });
    }
    if (!orgUnitIds.has(membership.orgUnitId)) {
      issues.push({
        severity: "error",
        rule: "valid-membership-unit",
        message: `Membership ${i} references non-existent org unit '${membership.orgUnitId}'`,
        path: `memberships[${i}].orgUnitId`,
      });
    }
  }

  // P1.1: Validate group member IDs
  for (const group of chart.groups) {
    for (const memberId of group.memberIds) {
      if (!agentIds.has(memberId)) {
        issues.push({
          severity: "error",
          rule: "valid-group-members",
          message: `Group '${group.id}' contains non-existent member '${memberId}'`,
          path: `groups.${group.id}.memberIds`,
        });
      }
    }
  }

  // P1.1: Warn about missing openclawAgentId
  for (const agent of chart.agents) {
    if (!agent.openclawAgentId && agent.active) {
      issues.push({
        severity: "warning",
        rule: "missing-openclaw-agent-id",
        message: `Active agent '${agent.id}' is missing openclawAgentId (needed for drift detection)`,
        path: `agents.${agent.id}.openclawAgentId`,
      });
    }
  }

  // P1.1: Validate relationship references
  for (let i = 0; i < chart.relationships.length; i++) {
    const rel = chart.relationships[i]!;
    if (!agentIds.has(rel.fromAgentId)) {
      issues.push({
        severity: "error",
        rule: "valid-relationship-from",
        message: `Relationship ${i} has invalid fromAgentId '${rel.fromAgentId}'`,
        path: `relationships[${i}].fromAgentId`,
      });
    }
    if (!agentIds.has(rel.toAgentId)) {
      issues.push({
        severity: "error",
        rule: "valid-relationship-to",
        message: `Relationship ${i} has invalid toAgentId '${rel.toAgentId}'`,
        path: `relationships[${i}].toAgentId`,
      });
    }
  }

  // P1.1: Detect self-escalation
  for (const rel of chart.relationships) {
    if (rel.type === "escalates_to" && rel.fromAgentId === rel.toAgentId) {
      issues.push({
        severity: "error",
        rule: "no-self-escalation",
        message: `Agent '${rel.fromAgentId}' escalates to itself`,
        path: `relationships`,
      });
    }
  }

  // P1.1: Detect circular escalation chains
  const escalationMap = new Map<string, string>();
  for (const rel of chart.relationships) {
    if (rel.type === "escalates_to" && rel.active) {
      escalationMap.set(rel.fromAgentId, rel.toAgentId);
    }
  }

  for (const [startAgent, _] of escalationMap) {
    const visited = new Set<string>();
    let current: string | undefined = startAgent;

    while (current) {
      if (visited.has(current)) {
        issues.push({
          severity: "error",
          rule: "no-circular-escalation",
          message: `Circular escalation chain detected starting from agent '${startAgent}'`,
          path: `relationships`,
        });
        break;
      }
      visited.add(current);
      current = escalationMap.get(current);
    }
  }

  // P1.1: Validate memory tier combinations (no cold in warm)
  function checkMemoryTiers(tiers: string[] | undefined, path: string) {
    if (!tiers) return;
    const hasCold = tiers.includes("cold");
    const hasWarmOrHot = tiers.includes("warm") || tiers.includes("hot");
    if (hasCold && hasWarmOrHot) {
      issues.push({
        severity: "error",
        rule: "no-cold-in-warm",
        message: `Memory policy cannot mix cold tier with warm/hot tiers`,
        path,
      });
    }
  }

  // Validate context budget policy thresholds (target <= warn <= critical)
  function checkContextBudgetPolicy(
    policy: { target: number; warn: number; critical: number } | undefined,
    path: string
  ) {
    if (!policy) return;

    if (policy.target > policy.warn) {
      issues.push({
        severity: "error",
        rule: "valid-context-budget-thresholds",
        message: `Context budget policy target (${policy.target}) must be <= warn (${policy.warn})`,
        path,
      });
    }

    if (policy.warn > policy.critical) {
      issues.push({
        severity: "error",
        rule: "valid-context-budget-thresholds",
        message: `Context budget policy warn (${policy.warn}) must be <= critical (${policy.critical})`,
        path,
      });
    }
  }

  // Check agent-level policies
  for (const agent of chart.agents) {
    if (agent.policies?.memory) {
      checkMemoryTiers(
        agent.policies.memory.tiers,
        `agents.${agent.id}.policies.memory.tiers`
      );
    }
    if (agent.policies?.context) {
      checkContextBudgetPolicy(
        agent.policies.context,
        `agents.${agent.id}.policies.context`
      );
    }
  }

  // Check default policies
  if (chart.defaults?.policies?.memory) {
    checkMemoryTiers(
      chart.defaults.policies.memory.tiers,
      "defaults.policies.memory.tiers"
    );
  }
  if (chart.defaults?.policies?.context) {
    checkContextBudgetPolicy(
      chart.defaults.policies.context,
      "defaults.policies.context"
    );
  }

  // Memory V2: validate memoryPools
  if (chart.memoryPools) {
    const memoryPools = chart.memoryPools;
    const warmIds = new Set<string>();
    const seenPaths = new Map<string, string>();

    const registerPath = (path: string, poolId: string, lintPath: string) => {
      const existing = seenPaths.get(path);
      if (existing) {
        issues.push({
          severity: "error",
          rule: "unique-memory-pool-path",
          message: `Memory pool path '${path}' is used by both '${existing}' and '${poolId}'`,
          path: lintPath,
        });
        return;
      }
      seenPaths.set(path, poolId);
    };

    registerPath(memoryPools.hot.path, "hot", "memoryPools.hot.path");

    for (const pool of memoryPools.warm) {
      if (warmIds.has(pool.id)) {
        issues.push({
          severity: "error",
          rule: "unique-memory-pool-id",
          message: `Duplicate memory pool id '${pool.id}'`,
          path: `memoryPools.warm.${pool.id}.id`,
        });
      } else {
        warmIds.add(pool.id);
      }

      registerPath(pool.path, pool.id, `memoryPools.warm.${pool.id}.path`);
    }

    const poolPaths = [
      { id: "hot", path: memoryPools.hot.path, lintPath: "memoryPools.hot.path" },
      ...memoryPools.warm.map(pool => ({
        id: pool.id,
        path: pool.path,
        lintPath: `memoryPools.warm.${pool.id}.path`,
      })),
    ];

    for (const cold of memoryPools.cold) {
      for (const pool of poolPaths) {
        if (pool.path.includes(cold)) {
          issues.push({
            severity: "error",
            rule: "no-cold-paths-in-pools",
            message: `Memory pool '${pool.id}' path '${pool.path}' contains cold substring '${cold}'`,
            path: pool.lintPath,
          });
        }
      }
    }

    const isWildcard = (role: string) => role.includes("*");
    const isAllAgents = (role: string) => role === "all";

    for (const pool of memoryPools.warm) {
      for (const role of pool.roles) {
        if (isAllAgents(role) || isWildcard(role)) continue;
        if (!agentIds.has(role)) {
          issues.push({
            severity: "error",
            rule: "valid-memory-pool-role",
            message: `Memory pool '${pool.id}' references unknown role '${role}'`,
            path: `memoryPools.warm.${pool.id}.roles`,
          });
        }
      }
    }

    if (memoryPools.hot.agents) {
      for (const agentId of memoryPools.hot.agents) {
        if (isAllAgents(agentId) || isWildcard(agentId)) continue;
        if (!agentIds.has(agentId)) {
          issues.push({
            severity: "error",
            rule: "valid-memory-pool-role",
            message: `Memory pool 'hot' references unknown role '${agentId}'`,
            path: "memoryPools.hot.agents",
          });
        }
      }
    }
  }

  return issues;
}
