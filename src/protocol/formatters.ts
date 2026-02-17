/**
 * Protocol message formatters — extracted from router.ts for modularity.
 */

import type { StatusUpdatePayload } from "../schemas/protocol.js";
import type { RunResult } from "../schemas/run-result.js";

export function buildCompletionReason(opts: { outcome: RunResult["outcome"]; notes?: string; blockers?: string[] }): string | undefined {
  if (opts.outcome === "blocked") {
    if (opts.blockers && opts.blockers.length > 0) return opts.blockers.join("; ");
  }
  return opts.notes;
}

export function buildStatusReason(payload: StatusUpdatePayload): string | undefined {
  if (payload.blockers && payload.blockers.length > 0) return payload.blockers.join("; ");
  if (payload.notes) return payload.notes;
  if (payload.progress) return payload.progress;
  return undefined;
}

export function shouldAppendWorkLog(payload: StatusUpdatePayload): boolean {
  return Boolean(payload.progress || payload.notes || (payload.blockers && payload.blockers.length > 0));
}

export function buildWorkLogEntry(payload: StatusUpdatePayload): string | null {
  const details: string[] = [];
  if (payload.progress) details.push(`Progress: ${payload.progress}`);
  if (payload.notes) details.push(`Notes: ${payload.notes}`);
  if (payload.blockers && payload.blockers.length > 0) {
    details.push(`Blockers: ${payload.blockers.join(", ")}`);
  }
  if (details.length === 0) return null;
  return `- ${new Date().toISOString()} ${details.join(" | ")}`;
}

export function appendSection(body: string, title: string, lines: string[]): string {
  if (lines.length === 0) return body;
  const section = [`## ${title}`, ...lines].join("\n");
  if (!body.trim()) return section;
  return `${body.trim()}\n\n${section}`;
}
