# Daemon Watchdog Design
**Phase:** 1.5 Recovery Hardening  
**Task:** AOF-r7b  
**Author:** swe-architect  
**Date:** 2026-02-13

## Overview

Implement health monitoring and auto-restart for the AOF daemon. The watchdog ensures daemon availability while respecting AOF's "ejectable" architecture (no hard OpenClaw dependency).

## Design Principles

1. **Pluggable, not mandatory** - AOF core exposes health primitives; external systems monitor
2. **Observable by default** - All restart attempts logged to events.jsonl
3. **Fail-safe** - After N retries, escalate to human (no infinite loops)
4. **OpenClaw-optional** - Can run with systemd, Docker healthcheck, or custom monitor

## Architecture

### Component 1: Health Check Endpoint

**Location:** `src/daemon/health.ts`

```typescript
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number; // milliseconds since start
  lastPollAt: string; // ISO8601 timestamp of last scheduler poll
  lastEventAt: string; // ISO8601 timestamp of last event written
  queueDepth: number; // tasks in ready queue
  version: string;
}

export async function getHealthStatus(): Promise<HealthStatus>;
```

**HTTP endpoint:** `GET /health` (exposed by daemon HTTP server)

**Health determination:**
- `healthy` - daemon running, scheduler polling normally (last poll < 60s ago)
- `degraded` - daemon running but scheduler stalled (last poll > 60s ago)
- `unhealthy` - daemon process dead or HTTP unresponsive

### Component 2: Watchdog Service

**Location:** `src/daemon/watchdog.ts`

```typescript
export interface WatchdogConfig {
  enabled: boolean; // default: false (opt-in)
  checkIntervalMs: number; // default: 60000 (1 min)
  restartAttempts: number; // default: 3
  restartWindowMs: number; // default: 3600000 (1 hour)
  alertChannels: string[]; // org-chart.yaml: ops.alertChannels
}

export class DaemonWatchdog {
  private restartHistory: Array<{ timestamp: number; success: boolean }>;
  
  async start(): Promise<void>;
  async stop(): Promise<void>;
  private async checkHealth(): Promise<void>;
  private async restartDaemon(): Promise<boolean>;
  private async alertOps(message: string): Promise<void>;
}
```

**Behavior:**
1. Every `checkIntervalMs`, call `GET /health`
2. If unhealthy:
   - Count restarts in last `restartWindowMs`
   - If < `restartAttempts`, attempt restart via `aof daemon restart`
   - Log restart attempt to `events.jsonl`
3. After `restartAttempts` exhausted:
   - Alert ops team via configured channels
   - Stop auto-restart (require manual intervention)
4. If healthy for > `restartWindowMs`, reset restart counter

### Component 3: Event Logging

**Schema addition to events.jsonl:**

```json
{
  "timestamp": "2026-02-13T16:00:00.000Z",
  "type": "watchdog.health_check",
  "status": "healthy",
  "uptime": 86400000,
  "queueDepth": 3
}

{
  "timestamp": "2026-02-13T16:00:00.000Z",
  "type": "watchdog.restart_attempt",
  "attempt": 1,
  "maxAttempts": 3,
  "reason": "daemon_unresponsive"
}

{
  "timestamp": "2026-02-13T16:00:00.000Z",
  "type": "watchdog.restart_success",
  "attempt": 1,
  "downtimeMs": 5000
}

{
  "timestamp": "2026-02-13T16:00:00.000Z",
  "type": "watchdog.restart_failed",
  "attempt": 1,
  "error": "spawn ENOENT"
}

{
  "timestamp": "2026-02-13T16:00:00.000Z",
  "type": "watchdog.max_restarts_exceeded",
  "attempts": 3,
  "windowMs": 3600000,
  "alertSent": true
}
```

## Integration Patterns

### Pattern 1: OpenClaw Plugin (Recommended)

**File:** `src/openclaw/watchdog.ts` (optional integration layer)

OpenClaw spawns watchdog service as background process:
```typescript
await openclaw.sessions.spawn({
  sessionId: 'aof-watchdog',
  persistent: true,
  command: 'node dist/daemon/watchdog.js'
});
```

### Pattern 2: Systemd

```ini
[Unit]
Description=AOF Daemon Watchdog
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/aof/dist/daemon/watchdog.js
Restart=on-failure
RestartSec=10
Environment="AOF_WATCHDOG_ENABLED=true"

[Install]
WantedBy=multi-user.target
```

### Pattern 3: Docker Healthcheck

```dockerfile
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

## Configuration

**org-chart.yaml:**

```yaml
aof:
  projects:
    my-project:
      watchdog:
        enabled: false # explicit opt-in
        checkIntervalMs: 60000
        restartAttempts: 3
        restartWindowMs: 3600000
      ops:
        alertChannels:
          - type: slack
            webhook: https://hooks.slack.com/...
          - type: email
            recipients: [ops@example.com]
```

## CLI Commands

**Start watchdog:**
```bash
aof daemon watchdog start
```

**Stop watchdog:**
```bash
aof daemon watchdog stop
```

**Check watchdog status:**
```bash
aof daemon watchdog status
```

## Testing Strategy

### Unit Tests
- `src/daemon/__tests__/health.test.ts`
  - Health status calculation (healthy/degraded/unhealthy)
  - Uptime tracking
  - Queue depth reporting

- `src/daemon/__tests__/watchdog.test.ts`
  - Restart logic (count, window, max attempts)
  - Alert triggering (after max restarts)
  - Restart counter reset (after stable uptime)

### Integration Tests
- `tests/e2e/watchdog.test.ts`
  - Kill daemon, verify watchdog restarts it
  - Exhaust restart attempts, verify alert sent
  - Stable uptime, verify counter reset

## Migration / Rollout

**Phase 1.5:** Watchdog disabled by default
- Opt-in via `aof.projects.<project>.watchdog.enabled: true`
- Document deployment patterns in `docs/DEPLOYMENT.md`

**Phase 2:** Consider default-enabled for production deployments
- Require explicit opt-out if not desired
- Add `aof init` wizard step to configure watchdog

## Open Questions

1. Should watchdog run in same process as daemon, or separate?
   - **Recommendation:** Separate process (watchdog can restart daemon cleanly)
2. How to handle watchdog process crash?
   - **Recommendation:** Rely on external supervision (systemd, Docker, OpenClaw)
3. Should health check ping the scheduler directly, or use HTTP endpoint?
   - **Recommendation:** HTTP endpoint (simpler, more portable)

## Acceptance Criteria

- ✅ `/health` endpoint returns status (healthy/degraded/unhealthy)
- ✅ Watchdog restarts daemon on failure (up to N times)
- ✅ After N restarts, watchdog alerts ops and stops retrying
- ✅ Restart counter resets after stable uptime window
- ✅ All restart attempts logged to events.jsonl
- ✅ Watchdog can be started/stopped via CLI
- ✅ Watchdog is disabled by default (opt-in)
- ✅ Integration tests validate restart behavior

## References

- PO Requirements: `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md`
- Task: `bd show AOF-r7b`
