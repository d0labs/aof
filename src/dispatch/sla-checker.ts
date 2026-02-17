/**
 * SLA Checker — detects tasks that exceed in-progress time limits.
 * 
 * Phase 1: Advisory mode only (alert on violation, no blocking).
 * Rate-limits alerts to prevent spam (1 alert per task per N minutes).
 */

import type { Task } from "../schemas/task.js";
import type { ProjectManifest } from "../schemas/project.js";
import { getSLALimit } from "../config/sla-defaults.js";

/** SLA violation detected by the checker. */
export interface SLAViolation {
  taskId: string;
  title: string;
  duration: number;           // Actual duration (ms)
  limit: number;              // SLA limit (ms)
  agent: string | undefined;  // Assigned agent
  timestamp: number;          // Violation detection time
}

/** Configuration for SLA checker. */
export interface SLACheckerConfig {
  /** Rate limit window in minutes (default: 15). */
  rateLimitMinutes?: number;
}

/**
 * SLA Checker implementation.
 * 
 * Tracks SLA violations and rate-limits alerts per task.
 */
export class SLAChecker {
  private alertHistory: Map<string, number[]> = new Map(); // taskId → timestamps
  private rateLimitMinutes: number;

  constructor(config: SLACheckerConfig = {}) {
    this.rateLimitMinutes = config.rateLimitMinutes ?? 15;
  }

  /**
   * Check for SLA violations in a list of tasks.
   * 
   * Only in-progress tasks are checked. Duration is calculated as
   * `now - task.updatedAt` per design doc.
   * 
   * @param tasks - List of tasks to check
   * @param project - Project manifest with SLA configuration
   * @returns List of SLA violations
   */
  checkViolations(
    tasks: Task[],
    project: Pick<ProjectManifest, "sla">
  ): SLAViolation[] {
    const now = Date.now();
    const violations: SLAViolation[] = [];

    for (const task of tasks) {
      // Only check in-progress tasks
      if (task.frontmatter.status !== "in-progress") {
        continue;
      }

      // Calculate duration since last update
      const updatedAt = new Date(task.frontmatter.updatedAt).getTime();
      const duration = now - updatedAt;

      // Get effective SLA limit for this task
      const limit = getSLALimit(task.frontmatter, project);

      // Check if duration exceeds limit
      if (duration > limit) {
        violations.push({
          taskId: task.frontmatter.id,
          title: task.frontmatter.title,
          duration,
          limit,
          agent: task.frontmatter.routing?.agent,
          timestamp: now,
        });
      }
    }

    return violations;
  }

  /**
   * Check if an alert should be sent for a task.
   * 
   * Returns false if an alert was sent recently (within rate limit window).
   * 
   * @param taskId - Task ID to check
   * @returns true if alert should be sent, false if rate-limited
   */
  shouldAlert(taskId: string): boolean {
    const now = Date.now();
    const history = this.alertHistory.get(taskId) ?? [];

    // Prune old alerts outside rate-limit window
    const cutoff = now - (this.rateLimitMinutes * 60 * 1000);
    const recentAlerts = history.filter(ts => ts > cutoff);
    this.alertHistory.set(taskId, recentAlerts);

    // Only alert if no recent alerts
    return recentAlerts.length === 0;
  }

  /**
   * Record that an alert was sent for a task.
   * 
   * This prevents duplicate alerts within the rate limit window.
   * 
   * @param taskId - Task ID that was alerted
   */
  recordAlert(taskId: string): void {
    const history = this.alertHistory.get(taskId) ?? [];
    history.push(Date.now());
    this.alertHistory.set(taskId, history);
  }
}
