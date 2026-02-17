/**
 * Org chart schema — domain-agnostic topology definition.
 *
 * The org chart is a YAML file that defines agent roles, teams,
 * reporting relationships, and routing rules. It is the single
 * source of truth for "who can do what" in the organization.
 *
 * Domain-agnostic: no hardcoded roles. Supports org templates.
 *
 * P1.1 Extensions: orgUnits, groups, memberships, relationships, policies
 */

import { z } from "zod";

/** Organizational unit (department, team, squad, etc.) */
export const OrgUnit = z.object({
  /** Unique ID for this org unit. */
  id: z.string().min(1),
  /** Human-readable name. */
  name: z.string().min(1),
  /** Unit type (department, team, squad, etc.) */
  type: z.string().min(1),
  /** Parent org unit ID (for tree structure). */
  parentId: z.string().optional(),
  /** Description. */
  description: z.string().optional(),
  /** Lead agent ID. */
  leadId: z.string().optional(),
  /** Whether this unit is active. */
  active: z.boolean().default(true),
  /** Arbitrary metadata. */
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type OrgUnit = z.infer<typeof OrgUnit>;

/** Group (cross-cutting collection of agents). */
export const OrgGroup = z.object({
  /** Unique ID for this group. */
  id: z.string().min(1),
  /** Human-readable name. */
  name: z.string().min(1),
  /** Description. */
  description: z.string().optional(),
  /** Agent IDs that are members of this group. */
  memberIds: z.array(z.string()),
  /** Arbitrary metadata. */
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type OrgGroup = z.infer<typeof OrgGroup>;

/** Agent membership in an org unit. */
export const OrgMembership = z.object({
  /** Agent ID. */
  agentId: z.string().min(1),
  /** Org unit ID. */
  orgUnitId: z.string().min(1),
  /** Role within the unit (optional). */
  role: z.string().optional(),
  /** Whether this is the agent's primary membership. */
  primary: z.boolean().default(true),
});
export type OrgMembership = z.infer<typeof OrgMembership>;

/** Relationship between agents (escalation, delegation, consultation). */
export const OrgRelationship = z.object({
  /** Source agent ID. */
  fromAgentId: z.string().min(1),
  /** Target agent ID. */
  toAgentId: z.string().min(1),
  /** Relationship type. */
  type: z.enum(["escalates_to", "delegates_to", "consults_with", "reports_to"]),
  /** Whether this relationship is active. */
  active: z.boolean().default(true),
  /** Arbitrary metadata. */
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type OrgRelationship = z.infer<typeof OrgRelationship>;

/** Memory access policy. */
export const MemoryPolicy = z.object({
  /** Memory scope paths (e.g., ["org/engineering", "shared/docs"]). */
  scope: z.array(z.string()),
  /** Allowed memory tiers. */
  tiers: z.array(z.enum(["hot", "warm", "cold"])),
  /** Read-only access. */
  readOnly: z.boolean().default(false),
});
export type MemoryPolicy = z.infer<typeof MemoryPolicy>;

/** Memory pool hot tier (always indexed). */
export const MemoryPoolHot = z.object({
  /** Path to the hot pool root. */
  path: z.string().min(1),
  /** Description of the pool. */
  description: z.string().optional(),
  /** Optional explicit agent list ("all" implied). */
  agents: z.array(z.string()).optional(),
});
export type MemoryPoolHot = z.infer<typeof MemoryPoolHot>;

/** Memory pool warm tier (role-scoped). */
export const MemoryPoolWarm = z.object({
  /** Unique pool ID. */
  id: z.string().min(1),
  /** Path to the warm pool root. */
  path: z.string().min(1),
  /** Description of the pool. */
  description: z.string().optional(),
  /** Role/agent patterns that should include this pool. */
  roles: z.array(z.string()).min(1),
});
export type MemoryPoolWarm = z.infer<typeof MemoryPoolWarm>;

/** Memory pool definitions for Memory V2. */
export const MemoryPools = z.object({
  hot: MemoryPoolHot,
  warm: z.array(MemoryPoolWarm),
  cold: z.array(z.string().min(1)),
  /** Memory retrieval adapter (default: "filesystem"). */
  adapter: z.enum(["filesystem", "lancedb"]).default("filesystem"),
});
export type MemoryPools = z.infer<typeof MemoryPools>;

/** Context budget policy — prevents context rot. */
export const ContextBudgetPolicy = z.object({
  /** Target budget (chars) — ideal context size. */
  target: z.number().int().positive(),
  /** Warning threshold (chars). */
  warn: z.number().int().positive(),
  /** Critical threshold (chars) — must truncate. */
  critical: z.number().int().positive(),
});
export type ContextBudgetPolicy = z.infer<typeof ContextBudgetPolicy>;

/** Communication policy. */
export const CommunicationPolicy = z.object({
  /** Allowed communication channels. */
  allowedChannels: z.array(z.string()),
  /** Whether communication requires approval. */
  requiresApproval: z.boolean().default(false),
  /** Restricted agent IDs (cannot communicate with). */
  restrictedAgents: z.array(z.string()).default([]),
});
export type CommunicationPolicy = z.infer<typeof CommunicationPolicy>;

/** Tasking policy. */
export const TaskingPolicy = z.object({
  /** Maximum concurrent tasks. */
  maxConcurrent: z.number().int().positive().default(1),
  /** Whether agent can self-assign tasks. */
  allowSelfAssign: z.boolean().default(false),
  /** Whether tasks require review. */
  requiresReview: z.boolean().default(false),
  /** Allowed task priorities. */
  allowedPriorities: z.array(z.string()).optional(),
});
export type TaskingPolicy = z.infer<typeof TaskingPolicy>;

/** Combined policies. */
export const OrgPolicies = z.object({
  memory: MemoryPolicy.optional(),
  communication: CommunicationPolicy.optional(),
  tasking: TaskingPolicy.optional(),
  context: ContextBudgetPolicy.optional(),
});
export type OrgPolicies = z.infer<typeof OrgPolicies>;

/** Default policies and settings. */
export const OrgDefaults = z.object({
  policies: OrgPolicies.optional(),
  /** Default agent capabilities. */
  capabilities: z.record(z.string(), z.unknown()).optional(),
});
export type OrgDefaults = z.infer<typeof OrgDefaults>;

/** Capability tags for routing. */
export const AgentCapabilities = z.object({
  tags: z.array(z.string()).default([]),
  /** Max concurrent tasks this agent can handle. */
  concurrency: z.number().int().positive().default(1),
  /** Model assigned to this agent (informational). */
  model: z.string().optional(),
  /** Provider type (informational, for cost tracking). */
  provider: z.string().optional(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

/** Communication preferences for an agent. */
export const AgentComms = z.object({
  /** Preferred dispatch method. */
  preferred: z.enum(["spawn", "send", "cli"]).default("send"),
  /** Session key for sessions_send. */
  sessionKey: z.string().optional(),
  /** Fallback methods in priority order. */
  fallbacks: z.array(z.enum(["spawn", "send", "cli"])).default(["send", "cli"]),
});
export type AgentComms = z.infer<typeof AgentComms>;

/** Single agent/role definition. */
export const OrgAgent = z.object({
  /** Agent ID (must match OpenClaw agent ID). */
  id: z.string().min(1),
  /** OpenClaw agent ID (e.g., "agent:main:main"). Used for drift detection. */
  openclawAgentId: z.string().optional(),
  /** Human-readable display name. */
  name: z.string().min(1),
  /** Role description. */
  description: z.string().optional(),
  /** Team membership (legacy, use memberships for P1.1+). */
  team: z.string().optional(),
  /** Reports-to agent ID (org hierarchy, legacy). */
  reportsTo: z.string().optional(),
  /** Whether this agent can delegate to others. */
  canDelegate: z.boolean().default(false),
  capabilities: AgentCapabilities.default({}),
  comms: AgentComms.default({}),
  /** Agent-specific policies. */
  policies: OrgPolicies.optional(),
  /** Whether this agent is active (inactive agents are skipped by dispatcher). */
  active: z.boolean().default(true),
});
export type OrgAgent = z.infer<typeof OrgAgent>;

/** Team definition. */
export const OrgTeam = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  /** Lead agent ID. */
  lead: z.string().optional(),
});
export type OrgTeam = z.infer<typeof OrgTeam>;

/** Routing rule for the dispatcher. */
export const RoutingRule = z.object({
  /** Match tasks with these tags. */
  matchTags: z.array(z.string()).default([]),
  /** Match tasks with this priority. */
  matchPriority: z.array(z.string()).default([]),
  /** Route to this role/agent. */
  targetRole: z.string().optional(),
  targetTeam: z.string().optional(),
  targetAgent: z.string().optional(),
  /** Rule priority (lower = evaluated first). */
  weight: z.number().int().default(100),
});
export type RoutingRule = z.infer<typeof RoutingRule>;

/** Memory curation configuration (optional). */
export const MemoryCuration = z.object({
  /** Path to curation policy file. */
  policyPath: z.string().min(1),
  /** Role responsible for curation tasks. */
  role: z.string().min(1),
});
export type MemoryCuration = z.infer<typeof MemoryCuration>;

/**
 * Role mapping for workflow gates — maps abstract roles to concrete agents.
 *
 * This enables workflow definitions to reference roles (e.g., "backend", "qa")
 * instead of hardcoding agent IDs. Agents can be rotated or load-balanced
 * without changing workflow definitions.
 */
export const RoleMapping = z.object({
  /** List of agents that can fulfill this role (at least one required). */
  agents: z.array(z.string()).min(1),
  /** Human-readable description of this role's responsibilities. */
  description: z.string().optional(),
  /** Whether this role requires human involvement (D3: human-only gates). */
  requireHuman: z.boolean().optional(),
});
export type RoleMapping = z.infer<typeof RoleMapping>;

/** Top-level org chart document. */
export const OrgChart = z.object({
  schemaVersion: z.literal(1),
  /** Template name (e.g., "swe-team", "ops-team"). */
  template: z.string().optional(),
  /** P1.1: Organizational units (tree structure). */
  orgUnits: z.array(OrgUnit).default([]),
  /** P1.1: Groups (cross-cutting collections). */
  groups: z.array(OrgGroup).default([]),
  /** P1.1: Agent memberships in org units. */
  memberships: z.array(OrgMembership).default([]),
  /** P1.1: Agent relationships (escalation, delegation, etc.). */
  relationships: z.array(OrgRelationship).default([]),
  /** P1.1: Default policies and settings. */
  defaults: OrgDefaults.optional(),
  /** Memory V2 pool definitions (optional in v1). */
  memoryPools: MemoryPools.optional(),
  /** Memory curation configuration (optional). */
  memoryCuration: MemoryCuration.optional(),
  /** Role-based agent mapping for workflow gates. */
  roles: z.record(z.string(), RoleMapping).optional(),
  /** Legacy: teams (use orgUnits for P1.1+). */
  teams: z.array(OrgTeam).default([]),
  /** Agents. */
  agents: z.array(OrgAgent),
  /** Legacy: routing rules (use relationships for P1.1+). */
  routing: z.array(RoutingRule).default([]),
  /** Arbitrary metadata. */
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type OrgChart = z.infer<typeof OrgChart>;

/**
 * Validate that all roles referenced in a workflow exist in the org chart.
 *
 * This ensures workflow gate definitions reference valid roles defined in
 * the org chart, preventing runtime errors when dispatching tasks.
 *
 * @param workflow - Workflow config with gates
 * @param orgChart - Org chart with role mappings
 * @returns Array of validation errors (empty if valid)
 */
export function validateWorkflowRoles(
  workflow: { gates: Array<{ role: string; escalateTo?: string }> },
  orgChart: { roles?: Record<string, RoleMapping> }
): string[] {
  const errors: string[] = [];
  const roles = orgChart.roles ?? {};

  for (const gate of workflow.gates) {
    if (!roles[gate.role]) {
      errors.push(`Gate references undefined role: ${gate.role}`);
    }
    if (gate.escalateTo && !roles[gate.escalateTo]) {
      errors.push(`Gate escalateTo references undefined role: ${gate.escalateTo}`);
    }
  }

  return errors;
}
