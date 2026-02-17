/**
 * Project manifest schema for project.yaml per Projects v0 spec.
 *
 * Each project lives under `<vaultRoot>/Projects/<projectId>/project.yaml`
 * and provides metadata for dispatcher, memory routing, and governance.
 */

import { z } from "zod";
import { WorkflowConfig } from "./workflow.js";

/** Valid project ID: [a-z0-9][a-z0-9-]{1,63} or special _inbox */
export const PROJECT_ID_REGEX = /^(_inbox|[a-z0-9][a-z0-9-]{1,63})$/;

/** Project status. */
export const ProjectStatus = z.enum(["active", "paused", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** Project type. */
export const ProjectType = z.enum([
  "swe",
  "ops",
  "research",
  "admin",
  "personal",
  "other",
]);
export type ProjectType = z.infer<typeof ProjectType>;

/** Project owner metadata. */
export const ProjectOwner = z.object({
  /** Team ID from org-chart. */
  team: z.string(),
  /** Lead agent or human ID. */
  lead: z.string(),
});
export type ProjectOwner = z.infer<typeof ProjectOwner>;

/** Routing config for project tasks. */
export const ProjectRouting = z.object({
  intake: z
    .object({
      default: z.string().default("Tasks/Backlog"),
    })
    .default({}),
  mailboxes: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
});
export type ProjectRouting = z.infer<typeof ProjectRouting>;

/** Memory indexing tier defaults. */
export const ProjectMemoryTiers = z.object({
  bronze: z.enum(["cold", "warm"]).default("cold"),
  silver: z.enum(["cold", "warm"]).default("warm"),
  gold: z.enum(["cold", "warm"]).default("warm"),
});
export type ProjectMemoryTiers = z.infer<typeof ProjectMemoryTiers>;

/** Memory indexing config. */
export const ProjectMemory = z.object({
  tiers: ProjectMemoryTiers.default({}),
  allowIndex: z
    .object({
      warmPaths: z.array(z.string()).default(["Artifacts/Silver", "Artifacts/Gold"]),
    })
    .default({}),
  denyIndex: z
    .array(z.string())
    .default(["Cold", "Artifacts/Bronze", "State", "Tasks"]),
});
export type ProjectMemory = z.infer<typeof ProjectMemory>;

/** External links for project. */
export const ProjectLinks = z.object({
  repo: z.string().optional(),
  dashboards: z.array(z.string()).default([]),
  docs: z.array(z.string()).default([]),
});
export type ProjectLinks = z.infer<typeof ProjectLinks>;

/** SLA configuration for project tasks. */
export const ProjectSLA = z.object({
  /** Default max in-progress duration for normal tasks (ms). */
  defaultMaxInProgressMs: z.number().int().positive().optional(),
  /** Default max in-progress duration for research tasks (ms). */
  researchMaxInProgressMs: z.number().int().positive().optional(),
  /** Violation policy (Phase 1: only 'alert' is supported). */
  onViolation: z.enum(["alert", "block", "deadletter"]).default("alert"),
  /** Alerting configuration. */
  alerting: z.object({
    /** Alert channel (slack, discord, email). */
    channel: z.string().optional(),
    /** Webhook URL for alerts. */
    webhook: z.string().optional(),
    /** Rate limit for alerts (minutes between alerts per task). */
    rateLimitMinutes: z.number().int().positive().default(15),
  }).optional(),
});
export type ProjectSLA = z.infer<typeof ProjectSLA>;

/** Project manifest (project.yaml). */
export const ProjectManifest = z.object({
  /** Project ID: must match directory name and follow [a-z0-9][a-z0-9-]{1,63} or be _inbox. */
  id: z.string().regex(PROJECT_ID_REGEX, {
    message: "Project ID must match [a-z0-9][a-z0-9-]{1,63} or be _inbox",
  }),
  /** Human-readable project title. */
  title: z.string(),
  /** Project status. */
  status: ProjectStatus.default("active"),
  /** Project type. */
  type: ProjectType,
  /** Owner metadata. */
  owner: ProjectOwner,
  /** Agent/human participants. */
  participants: z.array(z.string()).default([]),
  /** Optional parent project ID for hierarchical projects. */
  parentId: z.string().optional(),
  /** Routing config. */
  routing: ProjectRouting.default({}),
  /** Memory config. */
  memory: ProjectMemory.default({}),
  /** External links. */
  links: ProjectLinks.default({}),
  /** SLA configuration (time limits and violation handling). */
  sla: ProjectSLA.optional(),
  /** Workflow configuration (multi-stage task progression). */
  workflow: WorkflowConfig.optional(),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;
