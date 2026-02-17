export interface RestartRecord {
  timestamp: number;
  reason: string;
}

export interface RestartTrackerConfig {
  maxRestarts: number;
  windowMs: number;
}

export interface RestartTracker {
  canRestart(): boolean;
  recordRestart(reason: string): void;
  getHistory(): RestartRecord[];
}

export function createRestartTracker(config: RestartTrackerConfig): RestartTracker {
  const restarts: RestartRecord[] = [];

  function pruneOldRestarts(): void {
    const cutoff = Date.now() - config.windowMs;
    // Remove restarts older than the window
    while (restarts.length > 0 && restarts[0]!.timestamp < cutoff) {
      restarts.shift();
    }
  }

  return {
    canRestart(): boolean {
      pruneOldRestarts();
      return restarts.length < config.maxRestarts;
    },

    recordRestart(reason: string): void {
      restarts.push({
        timestamp: Date.now(),
        reason,
      });
      pruneOldRestarts();
    },

    getHistory(): RestartRecord[] {
      pruneOldRestarts();
      return [...restarts];
    },
  };
}
