/**
 * AOF Event Logger — append-only JSONL event log.
 *
 * Writes one JSON object per line to events/YYYY-MM-DD.jsonl.
 * Uses the BaseEvent schema from schemas/event.ts.
 */

import { appendFile, mkdir, symlink, unlink, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventType, BaseEvent } from "../schemas/event.js";

export type EventCallback = (event: BaseEvent) => void | Promise<void>;

export interface EventLoggerOptions {
  onEvent?: EventCallback;
}

export class EventLogger {
  private readonly eventsDir: string;
  private readonly onEvent?: EventCallback;
  private eventCounter: number = 0;

  constructor(eventsDir: string, options?: EventLoggerOptions) {
    this.eventsDir = eventsDir;
    this.onEvent = options?.onEvent;
  }

  /** Append an event to today's JSONL file. */
  async log(
    type: EventType,
    actor: string,
    opts?: {
      taskId?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<BaseEvent> {
    this.eventCounter += 1;

    const event: BaseEvent = {
      eventId: this.eventCounter,
      type,
      timestamp: new Date().toISOString(),
      actor,
      taskId: opts?.taskId,
      payload: opts?.payload ?? {},
    };

    const date = event.timestamp.slice(0, 10); // YYYY-MM-DD
    const filePath = join(this.eventsDir, `${date}.jsonl`);

    await mkdir(this.eventsDir, { recursive: true });
    const line = JSON.stringify(event) + "\n";
    await appendFile(filePath, line, "utf-8");

    // Maintain symlink to current log (BUG-005 fix)
    await this.updateSymlink(date);

    if (this.onEvent) {
      await Promise.resolve(this.onEvent(event));
    }

    return event;
  }

  /** Update events.jsonl symlink to point to current day's log. */
  private async updateSymlink(date: string): Promise<void> {
    const symlinkPath = join(this.eventsDir, "events.jsonl");
    const targetFilename = `${date}.jsonl`;

    try {
      // Remove existing symlink if present
      await unlink(symlinkPath);
    } catch {
      // Symlink doesn't exist yet, that's fine
    }

    try {
      // Create new symlink (relative, not absolute)
      await symlink(targetFilename, symlinkPath);
    } catch (err) {
      // Symlink creation failed - log but don't crash
      console.warn(`[EventLogger] Failed to update symlink: ${(err as Error).message}`);
    }
  }

  /** Log a task state transition. */
  async logTransition(
    taskId: string,
    from: string,
    to: string,
    actor: string,
    reason?: string,
  ): Promise<void> {
    await this.log("task.transitioned", actor, {
      taskId,
      payload: { from, to, reason },
    });
  }

  /** Log a lease event. */
  async logLease(
    type: "lease.acquired" | "lease.renewed" | "lease.expired" | "lease.released",
    taskId: string,
    agent: string,
  ): Promise<void> {
    await this.log(type, agent, { taskId });
  }

  /** Log a dispatch event. */
  async logDispatch(
    type: "dispatch.matched" | "dispatch.no-match" | "dispatch.fallback" | "dispatch.error",
    actor: string,
    taskId?: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.log(type, actor, { taskId, payload });
  }

  /** Log an action event (started/completed). */
  async logAction(
    type: "action.started" | "action.completed",
    actor: string,
    taskId: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.log(type, actor, { taskId, payload });
  }

  /** Log system events. */
  async logSystem(
    type: "system.startup" | "system.shutdown" | "system.config-changed" | "system.drift-detected" | "system.recovery",
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.log(type, "system", { payload });
  }

  /** Log scheduler poll events. */
  async logSchedulerPoll(
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.log("scheduler.poll", "scheduler", { payload });
  }

  /** Log context budget events. */
  async logContextBudget(
    taskId: string,
    actor: string,
    payload: {
      totalChars: number;
      estimatedTokens: number;
      status: "ok" | "warn" | "critical" | "over";
      policy?: {
        target: number;
        warn: number;
        critical: number;
      };
    },
  ): Promise<void> {
    await this.log("context.budget", actor, { taskId, payload });
  }

  /** Log context footprint measurement. */
  async logContextFootprint(
    agentId: string,
    payload: {
      totalChars: number;
      estimatedTokens: number;
      breakdownCount: number;
    },
  ): Promise<void> {
    await this.log("context.footprint", agentId, { payload });
  }

  /** Log context alert (threshold exceeded). */
  async logContextAlert(
    agentId: string,
    payload: {
      level: "warn" | "critical";
      currentChars: number;
      threshold: number;
      message: string;
    },
  ): Promise<void> {
    await this.log("context.alert", agentId, { payload });
  }

  /** Log task validation failure. */
  async logValidationFailed(
    filename: string,
    errors: string,
  ): Promise<void> {
    await this.log("task.validation.failed", "system", {
      payload: { filename, errors },
    });
  }

  /**
   * Query events from the log.
   * 
   * Reads all JSONL files in the events directory and filters by criteria.
   * 
   * @param filter - Filter criteria (e.g., { type: "sla.violation" })
   * @returns Array of matching events
   */
  async query(filter?: { type?: string; taskId?: string; actor?: string }): Promise<BaseEvent[]> {
    const files = await readdir(this.eventsDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && f !== 'events.jsonl');
    
    const events: BaseEvent[] = [];
    
    for (const file of jsonlFiles) {
      const filePath = join(this.eventsDir, file);
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as BaseEvent;
          
          // Apply filters
          if (filter?.type && event.type !== filter.type) continue;
          if (filter?.taskId && event.taskId !== filter.taskId) continue;
          if (filter?.actor && event.actor !== filter.actor) continue;
          
          events.push(event);
        } catch {
          // Skip malformed lines
        }
      }
    }
    
    return events;
  }
}
