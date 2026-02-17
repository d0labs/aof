# AOF Recovery CLI Reference

Quick reference for recovery-related CLI commands and flags (Phase 1.5).

---

## Recovery Flags

### `--recover-on-failure`

Available on: `task close`, `task update`, `task claim`

**Purpose:** Attempt automatic recovery if command fails (lease expiry only).

**Usage:**

```bash
aof task close <task-id> --recover-on-failure
aof task update <task-id> --field=value --recover-on-failure
aof task claim <task-id> --recover-on-failure
```

**What it does:**

1. Attempt normal command operation
2. On failure, check for **expired lease** (10-minute TTL)
3. Reclaim task to `ready` if expired
4. Log recovery action to event log
5. Show recovery summary, prompt manual retry

**Does NOT:**
- Retry the original command
- Fix validation or missing task errors
- Handle heartbeat staleness (Phase 2)

**Example output:**

```
❌ Failed to close AOF-123: Task has active lease

🔧 Recovery triggered:
   - Lease expired (10min TTL exceeded)
   - Task reclaimed to ready
✅ Recovery complete. Retry your command.

Retry: aof task close AOF-123
```

---

## Deadletter Commands

### `aof task resurrect <task-id>`

**Purpose:** Resurrect a task from deadletter status back to ready.

**Usage:**

```bash
aof task resurrect AOF-123
```

**Output:**

```
✅ Task AOF-123 resurrected (deadletter → ready)
   Ready for re-dispatch on next scheduler poll.
```

**Error cases:**

```bash
# Task not in deadletter
❌ Task AOF-123 not found in deadletter queue

# Task doesn't exist
❌ Task AOF-999 not found
```

---

## SLA Status (Phase 1.5)

There is **no dedicated SLA CLI command** in Phase 1.5. Use event logs:

```bash
# Tail latest event log
LATEST=$(ls -t ~/.openclaw/aof/events/*.jsonl 2>/dev/null | head -1)
tail -f "$LATEST"

# Filter SLA violations
cat "$LATEST" | jq 'select(.type == "sla.violation")'
```

---

## Health Check

### `GET /health`

**Usage:**

```bash
curl http://127.0.0.1:18000/health
```

**Healthy response:**

```json
{
  "status": "healthy",
  "uptime": 3600,
  "lastPollAt": 1707912000000,
  "lastEventAt": 1707911900000,
  "taskCounts": {
    "open": 5,
    "ready": 3,
    "inProgress": 2,
    "blocked": 1,
    "done": 42
  }
}
```

**Unhealthy response:**

```json
{
  "status": "unhealthy",
  "reason": "scheduler_stale",
  "uptime": 3600,
  "lastPollAt": 1707908400000,
  "lastEventAt": 1707908300000
}
```

---

## Configuration Reference

### Watchdog Configuration (`org-chart.yaml`)

```yaml
aof:
  daemon:
    watchdog:
      enabled: false
      pollIntervalMs: 60000
      healthEndpoint: "http://127.0.0.1:18000/health"
      restartPolicy:
        maxRestarts: 3
        windowMs: 3600000
```

### SLA Configuration (`project.yaml`)

```yaml
sla:
  defaultMaxInProgressMs: 3600000   # 1 hour
  researchMaxInProgressMs: 14400000 # 4 hours
  onViolation: alert
```

---

## Event Log Queries

```bash
# Recovery actions
cat "$LATEST" | jq 'select(.type == "recovery_action")'

# Deadletter transitions
cat "$LATEST" | jq 'select(.type == "task.deadletter")'

# SLA violations
cat "$LATEST" | jq 'select(.type == "sla.violation")'
```

---

## Quick Troubleshooting

### Task won't close (active lease)

```bash
# Try recovery
aof task close AOF-123 --recover-on-failure
```

### Task stuck in deadletter

```bash
# Check failure reason (task metadata)
cat tasks/deadletter/AOF-123.md

# Fix root cause, then resurrect
aof task resurrect AOF-123
```

### Daemon health check fails

```bash
curl http://127.0.0.1:18000/health
```

---

## See Also

- Full runbook: `docs/RECOVERY-RUNBOOK.md`
- SLA guide: `docs/SLA-GUIDE.md`
- Event logs: `docs/event-logs.md`
