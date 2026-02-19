/**
 * AudienceRouter — maps audience targets to notification channels.
 */

import type { Audience } from "./rules.js";

export type AudienceChannelMap = Record<Audience, string>;

export class AudienceRouter {
  private readonly defaults: AudienceChannelMap;

  constructor(defaults: AudienceChannelMap) {
    this.defaults = { ...defaults };
  }

  resolve(audience: Audience[], overrides: Partial<AudienceChannelMap> = {}): string[] {
    const map = { ...this.defaults, ...overrides };
    const channels = audience
      .map((target) => map[target])
      .filter((channel): channel is string => Boolean(channel));
    return Array.from(new Set(channels));
  }
}
