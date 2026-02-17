import type { RestartRecord } from "./restart-tracker.js";
import type { HealthStatus } from "../../daemon/health.js";

export interface OpsAlert {
  severity: "critical";
  title: string;
  body: string;
  metadata: {
    restartHistory: RestartRecord[];
    healthStatus: HealthStatus;
  };
}

export function formatAlert(restarts: RestartRecord[], health: HealthStatus): OpsAlert {
  const restartLines = restarts.map(r => 
    `- ${new Date(r.timestamp).toISOString()}: ${r.reason}`
  ).join("\n");

  const body = `
## Summary
The AOF daemon has failed and exceeded the auto-restart limit.

## Restart History
${restartLines || "(No restarts recorded)"}

## Current Health Status
- Status: ${health.status}
- Uptime: ${Math.round(health.uptime / 1000)}s
- Last Poll: ${new Date(health.lastPollAt).toISOString()}
- Last Event: ${new Date(health.lastEventAt).toISOString()}

## Task Counts
- Open: ${health.taskCounts.open}
- Ready: ${health.taskCounts.ready}
- In Progress: ${health.taskCounts.inProgress}
- Blocked: ${health.taskCounts.blocked}
- Done: ${health.taskCounts.done}

## Action Required
Manual investigation required. Check daemon logs for root cause.
  `.trim();

  return {
    severity: "critical",
    title: "AOF Daemon Auto-Restart Failed",
    body,
    metadata: {
      restartHistory: restarts,
      healthStatus: health,
    },
  };
}
