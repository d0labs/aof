/**
 * StormBatcher — batches notification storms by event type.
 */

import type { NotificationAdapter } from "../notifier.js";

export interface StormBatcherOptions {
  windowMs?: number;
  threshold?: number;
}

export interface QueuedNotification {
  eventType: string;
  channel: string;
  message: string;
  critical?: boolean;
}

interface QueuedGroup {
  channel: string;
  messages: string[];
}

export class StormBatcher {
  private readonly adapter: NotificationAdapter;
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly pending: Map<string, QueuedGroup> = new Map();
  private timer: NodeJS.Timeout | null = null;

  constructor(adapter: NotificationAdapter, options: StormBatcherOptions = {}) {
    this.adapter = adapter;
    this.windowMs = options.windowMs ?? 10_000;
    this.threshold = options.threshold ?? 5;
  }

  async enqueue(notification: QueuedNotification): Promise<void> {
    if (notification.critical) {
      await this.safeSend(notification.channel, notification.message);
      return;
    }

    const group = this.pending.get(notification.eventType);
    if (group) {
      group.messages.push(notification.message);
    } else {
      this.pending.set(notification.eventType, {
        channel: notification.channel,
        messages: [notification.message],
      });
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.windowMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const groups = Array.from(this.pending.entries());
    this.pending.clear();

    for (const [eventType, group] of groups) {
      const count = group.messages.length;
      if (count > this.threshold) {
        await this.safeSend(
          group.channel,
          `🌀 ${eventType} storm: ${count} events`
        );
      } else {
        for (const message of group.messages) {
          await this.safeSend(group.channel, message);
        }
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async safeSend(channel: string, message: string): Promise<void> {
    try {
      await this.adapter.send(channel, message);
    } catch (err) {
      console.error(`[StormBatcher] Failed to send notification (${channel}):`, err);
    }
  }
}
