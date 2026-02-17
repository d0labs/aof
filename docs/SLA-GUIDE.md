# AOF SLA Guide

**Audience:** Project leads, PMs, SREs  
**Scope:** SLA configuration, alerting, and tuning (Phase 1.5)

---

## Overview

AOF’s SLA primitive detects **in-progress tasks** that exceed expected duration and emits **advisory alerts**. Phase 1.5 is **alert-only** — no blocking or automatic transitions.

**Defaults (Phase 1.5):**
- **Normal tasks:** 1 hour (`3600000ms`)
- **Research tasks:** 4 hours (`14400000ms`) when `routing.agent: swe-researcher`
- **Alert rate limit:** 1 per task per 15 minutes

---

## 1. SLA Configuration Hierarchy

SLA limits are resolved in this order:

1. **Per-task override** (task frontmatter)
2. **Per-project defaults** (`org/org-chart.yaml` → `aof.projects.<projectId>.sla`)
3. **Global fallback** (1 hour)

---

## 2. Per-Task Overrides

Add SLA overrides in task frontmatter:

```yaml
---
id: AOF-123
title: Deep research spike
status: in-progress
routing:
  agent: swe-researcher
sla:
  maxInProgressMs: 14400000  # 4 hours
  onViolation: alert         # Phase 1: only 'alert' supported
---
```

**Validation rules:**
- `maxInProgressMs` must be between **1 minute** and **24 hours**
- `onViolation` must be `alert` (Phase 1 constraint)

---

## 3. Project Defaults (`org/org-chart.yaml`)

Per-project defaults live in the org chart under `aof.projects.<projectId>.sla`:

```yaml
aof:
  projects:
    backend:
      sla:
        defaultMaxInProgressMs: 3600000   # 1 hour
        researchMaxInProgressMs: 14400000 # 4 hours (applies to routing.agent: swe-researcher)
        onViolation: alert                # Phase 1: advisory only
        alerting:
          rateLimitMinutes: 15
```

---

## 4. onViolation Modes

`onViolation` controls what happens when a task exceeds its SLA:
- `alert` — emit an advisory alert (Phase 1.5 default and only supported mode)
- `block` — transition task to `blocked` (Phase 2)
- `deadletter` — transition task to `deadletter` (Phase 2)

⚠️ **Phase 1 constraint:** `block` and `deadletter` are rejected by validation in Phase 1.5.

---

## 5. How SLA Checks Work

- Scheduler checks **every poll cycle** (default 30s)
- Duration is computed as: `now - task.updatedAt`
- If duration > limit → `sla.violation` event + console alert
- Alerts are rate-limited to **1 per task per 15 minutes**

---

## 6. Alert Format (Console)

```
[AOF] SLA VIOLATION: Task AOF-123 (Implement auth middleware)
[AOF] SLA VIOLATION:   Duration: 1.3h (limit: 1.0h)
[AOF] SLA VIOLATION:   Agent: swe-backend
[AOF] SLA VIOLATION:   Action: Check if agent is stuck or task needs SLA override
```

**Phase 2:** External alert channels (Slack/Discord/email) are planned.

---

## 7. Querying SLA Violations

Use event logs to find violations:

```bash
# Tail latest events
LATEST=$(ls -t ~/.openclaw/aof/events/*.jsonl 2>/dev/null | head -1)
tail -f "$LATEST"

# Filter SLA violations
cat "$LATEST" | jq 'select(.type == "sla.violation")'
```

Example event:
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

---

## 8. Tuning SLAs

**Start conservative:**
- Keep 1h/4h defaults initially
- Observe alerts over 1–2 weeks
- Adjust based on real duration data

**Red flags:**
- Too many alerts → limits too aggressive
- No alerts ever → limits too generous
- Alerts for expected long tasks → add per-task overrides

**Example: increase backend defaults to 2 hours**

```yaml
sla:
  defaultMaxInProgressMs: 7200000  # 2 hours
```

---

## 9. Troubleshooting

**SLA alerts too noisy:**
- Increase project defaults
- Add per-task overrides
- Verify task is correctly marked `in-progress`

**No SLA alerts at all:**
- Confirm daemon is running
- Confirm tasks are in `in-progress`
- Check event logs for `scheduler.poll`

---

## References

- Recovery runbook: `docs/RECOVERY-RUNBOOK.md`
- SLA design: `docs/SLA-PRIMITIVE-DESIGN.md`
- Event logs: `docs/event-logs.md`
