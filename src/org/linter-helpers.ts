/**
 * Linter helper functions for policy validation.
 * 
 * Extracted from linter.ts to meet size budget.
 */

import type { LintIssue } from "./linter.js";

/**
 * Validate memory tier combinations (no cold in warm).
 */
export function checkMemoryTiers(tiers: string[] | undefined, path: string): LintIssue | undefined {
  if (!tiers) return undefined;
  const hasCold = tiers.includes("cold");
  const hasWarmOrHot = tiers.includes("warm") || tiers.includes("hot");
  if (hasCold && hasWarmOrHot) {
    return {
      severity: "error",
      rule: "no-cold-in-warm",
      message: `Memory policy cannot mix cold tier with warm/hot tiers`,
      path,
    };
  }
  return undefined;
}

/**
 * Validate context budget policy thresholds (target <= warn <= critical).
 */
export function checkContextBudgetPolicy(
  policy: { target: number; warn: number; critical: number } | undefined,
  path: string
): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!policy) return issues;

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

  return issues;
}
