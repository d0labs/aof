/**
 * ConsoleNotifier — NotificationAdapter for standalone / daemon mode.
 *
 * Formats notifications as structured console output so they remain
 * visible in server logs without requiring a Matrix connection.
 *
 * Used by default when no messageTool is present (i.e. when AOF runs
 * outside of the OpenClaw plugin environment).
 */

import type { NotificationAdapter } from "../events/notifier.js";

export class ConsoleNotifier implements NotificationAdapter {
  private readonly prefix: string;

  constructor(opts?: { prefix?: string }) {
    this.prefix = opts?.prefix ?? "[AOF]";
  }

  async send(channel: string, message: string): Promise<void> {
    // Skip empty messages (e.g. suppressed scheduler.poll templates)
    if (!message) return;
    console.info(`${this.prefix} [${channel}] ${message}`);
  }
}
