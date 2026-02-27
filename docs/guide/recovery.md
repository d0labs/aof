---
title: "AOF Recovery Runbook"
description: "Troubleshooting and incident response procedures."
---

**Version:** Phase 1.5  
**Last Updated:** 2026-02-15  
**Audience:** Operators, SREs, DevOps teams

---

## Overview

This runbook covers recovery features introduced in Phase 1.5 Recovery Hardening. These features detect and surface stalled tasks, daemon failures, and dispatch problems. All features are **opt-in** or **advisory** and follow AOF's ejectable design philosophy.

**Covered features:**
- Daemon health monitoring (watchdog)
- CLI recovery hooks (`--recover-on-failure`)
- Deadletter task handling + resurrection
- SLA alerting (advisory)

**Operational truths (Phase 1.5):**
- Recovery actions require explicit operator intent
- SLA + deadletter alerts are **console alerts** (stderr) in Phase 1.5
- Event logs are **date-rotated** JSONL files

See also:
- `docs/DEPLOYMENT.md` (watchdog deployment patterns)
- `docs/SLA-GUIDE.md` (SLA configuration + tuning)
- `docs/event-logs.md` (event log locations)

---

## 1. Daemon Health Monitoring (Watchdog)

The watchdog monitors the daemon health endpoint and triggers a restart via a platform-specific hook (OpenClaw integration, systemd, Docker, etc.). It stops after 3 restarts in a 1-hour window and emits a critical alert.

### When to Enable

**Enable watchdog if:**
- You need high availability (auto-restart)
- You run AOF in production or staging
- You want automated health checks and failure visibility

**Don’t enable watchdog if:**
- You prefer manual restarts
- You already use a process supervisor (systemd/Docker) and don’t want duplication
- You’re in a dev/local environment

### Configuration

**Location:** `org-chart.yaml` under `aof.daemon.watchdog`

```yaml
aof:
  daemon:
    watchdog:
      enabled: true              # Default: false (opt-in)
      pollIntervalMs: 60000      # Check health every 60s
      healthEndpoint: "http://127.0.0.1:18000/health"
      restartPolicy:
        maxRestarts: 3           # Max restarts in 1hr window
        windowMs: 3600000        # 1hr window for restart counting
      alerting:
        channel: slack           # slack | discord | email (Phase 2)
        webhook: "https://hooks.slack.com/..."
```

**Notes:**
- The **health endpoint** is the daemon’s `/health` (default port **18000**).
- In Phase 1.5, watchdog alerts are **console output** unless a deployment-specific hook forwards them.
- External channels (Slack/Discord/email) are planned in Phase 2.

### How It Works

1. Watchdog polls `/health` every `pollIntervalMs`
2. If health check fails, watchdog triggers a restart **hook**
3. Restart count increments within the 1-hour window
4. After 3 failures in 1 hour, watchdog stops and alerts ops

### Alert Format (Console)

```
[Watchdog] Max restarts exceeded, alerting ops team
## Summary
The AOF daemon has failed and exceeded the auto-restart limit.

## Restart History
- 2026-02-14T14:00:00.000Z: health check failed
- 2026-02-14T14:15:00.000Z: health check failed
- 2026-02-14T14:30:00.000Z: health check failed

## Current Health Status
- Status: unhealthy
- Uptime: 0s
- Last Poll: 2026-02-14T14:29:00.000Z
- Last Event: 2026-02-14T14:28:30.000Z

## Task Counts
- Open: 0
- Ready: 0
- In Progress: 2
- Blocked: 1
- Done: 42

## Action Required
Manual investigation required. Check daemon logs for root cause.
```

### Troubleshooting

```bash
# Verify health endpoint
curl http://127.0.0.1:18000/health

# Check daemon status (if started via CLI)
aof daemon status --port 18000
```

If you’re using OpenClaw Gateway, check gateway logs:
```
tail -f ~/.openclaw/logs/gateway.log | grep "\[AOF\]"
```

---

## 2. CLI Recovery Hooks

CLI commands can attempt recovery **only when you pass** `--recover-on-failure`. In Phase 1.5, recovery checks **expired leases** (10-minute TTL) and reclaims the task to `ready`. Heartbeat staleness recovery is handled by the daemon; CLI recovery does not attempt it in Phase 1.5.

### Supported Commands
- `aof task close --recover-on-failure`
- `aof task update --recover-on-failure`
- `aof task claim --recover-on-failure`

### How It Works

1. Command attempts the normal operation
2. On failure, recovery checks **lease expiry**
3. If expired, task transitions to `ready`
4. Recovery action logged as `recovery_action`
5. Operator retries command manually

### Example

```bash
$ aof task close AOF-123 --recover-on-failure

❌ Failed to close AOF-123: Task has active lease

🔧 Recovery triggered:
   - Lease expired (10min TTL exceeded)
   - Task reclaimed to ready
✅ Recovery complete. Retry your command.

Retry: aof task close AOF-123
```

### Event Log Example

```json
{
  "timestamp": "2026-02-14T09:00:00.000Z",
  "type": "recovery_action",
  "taskId": "AOF-123",
  "actor": "system",
  "payload": {
    "action": "lease_expired",
    "details": {
      "leaseExpiredAt": "2026-02-14T08:45:00.000Z",
      "transitionedTo": "ready"
    }
  }
}
```

---

## 3. Deadletter Tasks

Tasks that fail dispatch **3 consecutive times** transition to `deadletter`. Deadletter tasks require manual intervention and explicit resurrection.

### Identifying Deadletter Tasks

```bash
# List deadletter tasks (filesystem)
ls tasks/deadletter/

# List deadletter tasks (CLI)
aof task list --status deadletter
```

### Inspecting a Deadletter Task

```bash
# Show task metadata (if available in your CLI)
aof task show AOF-123

# Or read the file directly
cat tasks/deadletter/AOF-123.md

# Inspect the deadletter event payload
LATEST=$(ls -t ~/.openclaw/aof/events/*.jsonl 2>/dev/null | head -1)
cat "$LATEST" | jq 'select(.type == "task.deadletter" and .taskId == "AOF-123")'
```

### Resurrection Workflow

```bash
$ aof task resurrect AOF-123

✅ Task AOF-123 resurrected (deadletter → ready)
   Ready for re-dispatch on next scheduler poll.
```

**What resurrection does:**
1. `deadletter → ready`
2. Moves file: `tasks/deadletter/` → `tasks/ready/`
3. Resets dispatch failure counters
4. Logs `task.resurrected`

### Deadletter Alert (Console)

When a task transitions to deadletter, the scheduler emits a console alert:

```
[AOF] DEADLETTER: Task AOF-123 (Implement auth middleware)
[AOF] DEADLETTER:   Failure count: 3
[AOF] DEADLETTER:   Last failure: agent_unavailable
[AOF] DEADLETTER:   Agent: swe-backend
[AOF] DEADLETTER:   Action: Investigate failure cause before resurrection
```

**Phase 2:** External channels (Slack/Discord/email) planned. Phase 1.5 uses console output only.

### Event Log Example

```json
{
  "timestamp": "2026-02-14T09:00:00.000Z",
  "type": "task.deadletter",
  "taskId": "AOF-123",
  "actor": "system",
  "payload": {
    "reason": "max_dispatch_failures",
    "failureCount": 3,
    "lastFailureReason": "agent_unavailable"
  }
}
```

---

## 4. SLA Configuration (Advisory Alerts)

SLA checks detect tasks that stay **in-progress** longer than expected. Phase 1.5 is **alert-only** — no blocking or automatic transitions.

### SLA Hierarchy
1. **Per-task override** (frontmatter)
2. **Per-project defaults** (`org/org-chart.yaml` → `aof.projects.<projectId>.sla`)
3. **Global fallback** (1 hour)

### Per-Task Override (task frontmatter)

```yaml
---
id: AOF-123
title: Deep research spike
status: in-progress
sla:
  maxInProgressMs: 14400000  # 4 hours
  onViolation: alert         # Phase 1: only 'alert' is supported
---
```

### Project Defaults (`org/org-chart.yaml`)

```yaml
aof:
  projects:
    my-project:
      sla:
        defaultMaxInProgressMs: 3600000   # 1 hour
        researchMaxInProgressMs: 14400000 # 4 hours (applies to routing.agent: swe-researcher)
        onViolation: alert                # Phase 1: advisory only
        alerting:
          rateLimitMinutes: 15
```

### How SLA Checks Work

- Scheduler checks **every poll cycle** (default 30s)
- Duration = `now - task.updatedAt`
- If duration > limit → log `sla.violation`
- Console alert rate-limited to **1 per task per 15 minutes**

### Violation Modes

`onViolation` supports the following modes:
- `alert` — emit an alert (Phase 1.5 default and only supported mode)
- `block` — transition to `blocked` (Phase 2)
- `deadletter` — transition to `deadletter` (Phase 2)

### Alert Format (Console)

```
[AOF] SLA VIOLATION: Task AOF-123 (Implement auth middleware)
[AOF] SLA VIOLATION:   Duration: 1.3h (limit: 1.0h)
[AOF] SLA VIOLATION:   Agent: swe-backend
[AOF] SLA VIOLATION:   Action: Check if agent is stuck or task needs SLA override
```

### Event Log Example

```json
{
  "timestamp": "2026-02-14T09:00:00.000Z",
  "type": "sla.violation",
  "actor": "scheduler",
  "taskId": "AOF-123",
  "payload": {
    "duration": 4500000,
    "limit": 3600000,
    "agent": "swe-backend",
    "timestamp": 1707901200000
  }
}
```

### Phase 1 Constraint

⚠️ Only `onViolation: alert` is supported. Setting `block` or `deadletter` will fail validation.

---

## 5. Troubleshooting & Diagnostics

### Event Logs (Date-Rotated)

```bash
# Tail the latest event log
LATEST=$(ls -t ~/.openclaw/aof/events/*.jsonl 2>/dev/null | head -1)
tail -f "$LATEST"
```

### Common Issues

- **Watchdog not restarting daemon:**
  - Confirm `/health` returns 200
  - Verify watchdog is enabled in `org-chart.yaml`
  - Ensure restart hook is wired (systemd/Docker/OpenClaw)

- **Recovery not triggered:**
  - Ensure `--recover-on-failure` is present
  - Confirm lease TTL exceeded (10 minutes)

- **Deadletter tasks accumulating:**
  - Inspect failure reasons (`lastDispatchFailureReason`)
  - Ensure eligible agents are available
  - Resurrect only after fixing the root cause

- **SLA alerts too noisy:**
  - Increase `defaultMaxInProgressMs` or add per-task overrides

---

## Appendix: Event Types (Recovery)

| Event Type | Description |
|------------|-------------|
| `recovery_action` | CLI recovery action taken (lease expired, etc.) |
| `task.deadletter` | Task transitioned to deadletter |
| `task.resurrected` | Task resurrected from deadletter |
| `sla.violation` | Task exceeded SLA limit |

---

## Appendix: Feature Compatibility Matrix

| Feature | Default | Can Disable? | Notes |
|---------|---------|--------------|-------|
| Watchdog | Disabled | Yes | Opt-in via `org-chart.yaml` |
| CLI recovery | Disabled | Yes | Only when `--recover-on-failure` is used |
| Deadletter | Enabled | No | Triggers after 3 failures |
| Deadletter alert | Enabled | No | Console alert (Phase 1.5) |
| SLA checks | Enabled | No | Advisory only (console alerts) |

---

## Getting Help

- Event logs: `docs/event-logs.md`
- Watchdog design: `docs/design/DAEMON-WATCHDOG-DESIGN.md`
- SLA design: `docs/SLA-PRIMITIVE-DESIGN.md`
- CLI recovery reference: `docs/CLI-RECOVERY-REFERENCE.md`
