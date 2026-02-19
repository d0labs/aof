# Project Xray — Integration Test Plan

**Version:** 1.0  
**Date:** 2026-02-19  
**Environment:** Mule (`100.65.243.89`, SSH: `ssh mule-openclaw`)  
**AOF Plugin:** Loaded, dryRun=false, poll=30s  

---

## Overview

Project Xray validates AOF running autonomously on the Mule test environment. This plan defines two monitoring tiers: a **15-minute health check** (automated, cron-driven) and a **1-hour process audit** (deeper, agent-assisted).

Both tiers report findings to Matrix (`mancorpbots`) and log to `memory/xray-runs/`.

---

## Tier 1: Health Check (every 15 minutes)

**Goal:** Detect crashes, stuck agents, tool access failures, and infrastructure issues fast.

**Runner:** Cron job → isolated agentTurn (Haiku or Sonnet)

### 1.1 — Agent Liveness

| Check | Method | Pass Criteria | Severity |
|-------|--------|---------------|----------|
| Gateway responsive | `ssh mule-openclaw "curl -s http://localhost:18789/"` | HTTP 200 | 🔴 CRITICAL |
| AOF plugin loaded | `ssh mule-openclaw "curl -s http://localhost:18789/aof/status"` | JSON with `scheduler: running` | 🔴 CRITICAL |
| Active sessions exist | `ssh mule-openclaw "openclaw status"` → check agent count | >0 active sessions | 🟡 WARN |
| No zombie processes | `ssh mule-openclaw "ps aux \| grep openclaw \| grep -v grep"` | Single gateway PID | 🟡 WARN |

### 1.2 — Stuck/Crashed Agent Detection

| Check | Method | Pass Criteria | Severity |
|-------|--------|---------------|----------|
| Tasks stuck in `in_progress` | AOF status API: tasks with `in_progress` status >30min | 0 tasks stuck >30min | 🔴 HIGH |
| Expired leases not recovered | Check for tasks with expired lease but not transitioned to `ready` | 0 orphaned leases | 🔴 HIGH |
| Scheduler poll running | Gateway logs: last `scheduler.poll` event <2 poll cycles old | <60s since last poll | 🟠 MEDIUM |
| Dispatch failures | Gateway logs: `dispatch.failed` events in last 15min | 0 new failures | 🟠 MEDIUM |

### 1.3 — Tool Access Verification

| Check | Method | Pass Criteria | Severity |
|-------|--------|---------------|----------|
| AOF tools visible to agents | Spawn test-agent, check `aof_task_list` exists in tool set | Tool present | 🔴 HIGH |
| Serena tools available | Spawn test-agent (swe profile), check `find_symbol` exists | Tool present | 🔴 HIGH |
| `sessions_spawn` not blocked | `curl` gateway HTTP `/tools/invoke` with sessions_spawn | Not denied | 🔴 HIGH |
| Memory search operational | `ssh mule-openclaw "openclaw status --deep"` → memory status | `vector ready`, `fts ready` | 🟠 MEDIUM |

### 1.4 — Error Detection

| Check | Method | Pass Criteria | Severity |
|-------|--------|---------------|----------|
| Gateway error log | `ssh mule-openclaw "tail -50 ~/.openclaw/logs/gateway.log"` → grep ERROR | 0 new errors since last check | 🟠 MEDIUM |
| Plugin crash/restart | Check AOF plugin uptime vs gateway uptime | Plugin uptime ≈ gateway uptime | 🔴 HIGH |
| OOM / resource exhaustion | `ssh mule-openclaw "free -m && df -h /"` | >500MB RAM free, >1GB disk | 🟡 WARN |

### Tier 1 Output Format

```markdown
## Xray Health Check — {timestamp}

**Status:** 🟢 HEALTHY / 🟡 DEGRADED / 🔴 CRITICAL

| Category | Checks | Pass | Fail | Severity |
|----------|--------|------|------|----------|
| Liveness | 4 | 4 | 0 | — |
| Stuck/Crashed | 4 | 3 | 1 | 🔴 HIGH |
| Tool Access | 4 | 4 | 0 | — |
| Errors | 3 | 3 | 0 | — |

### Failures
- **Stuck task detected**: AOF-xyz in `in_progress` for 45min (lease expired 15min ago)
  - Action: investigate dispatch logs, check if agent crashed

### Metrics
- Tasks: 3 ready, 2 in_progress, 15 done, 1 blocked
- Dispatches (15min): 2 started, 1 completed, 0 failed
- Memory: 512MB free, 4.2GB disk free
```

---

## Tier 2: Process Audit (every 1 hour)

**Goal:** Verify agents are following the SDLC, routing correctly, using memory, and making progress — not just alive.

**Runner:** Cron job → isolated agentTurn (Sonnet, longer timeout)

### 2.1 — SDLC Compliance

| Check | Method | Pass Criteria | Severity |
|-------|--------|---------------|----------|
| Tasks follow state machine | Scan task files: transitions match `backlog→ready→in_progress→code_review→qa_review→done` | No skipped states | 🔴 HIGH |
| Gate 1 enforced (tests) | Check completed tasks: do they have test artifacts? | >80% have test evidence | 🟠 MEDIUM |
| Gate 2 enforced (review) | Check completed tasks: do they have review artifacts/comments? | >80% have review evidence | 🟠 MEDIUM |
| Gate 3 enforced (integration) | Check completed tasks: integration test results present? | For applicable tasks | 🟡 WARN |
| No tasks skipping gates | Audit task event log: any `in_progress→done` without intermediate states? | 0 gate-skip events | 🔴 HIGH |
| TDD evidence | Check if test files were committed BEFORE implementation files (git log analysis) | Informational | 📊 INFO |

### 2.2 — Task Routing & Dispatch

| Check | Method | Pass Criteria | Severity |
|-------|--------|---------------|----------|
| Tasks routed to correct agent | Cross-ref task `routing.agent` with org chart role assignment | >90% correctly routed | 🟠 MEDIUM |
| No infinite re-dispatch loops | Check event log: same task dispatched >3x without progress | 0 re-dispatch loops | 🔴 HIGH |
| Handoff protocol working | Check for `handoff.request` / `handoff.accepted` pairs | Pairs match (no orphan requests >30min) | 🟠 MEDIUM |
| Completion signals received | Tasks dispatched vs completion signals | >60% completion rate in last hour | 🟠 MEDIUM |
| Delegation depth reasonable | Check `delegationDepth` on active tasks | None >3 | 🟡 WARN |

### 2.3 — Memory System Usage

| Check | Method | Pass Criteria | Severity |
|-------|--------|---------------|----------|
| Agents querying memory | Check `memory_search` tool calls in session logs | >0 queries per active agent per hour | 🟠 MEDIUM |
| Memory writes happening | Check warm tier for updates in last hour | >0 new/updated warm docs | 🟡 WARN |
| Memory recall quality | Sample a memory query, check if results are relevant | Subjective — flag if clearly broken | 📊 INFO |
| Hot tier within size limit | Check `Resources/OpenClaw/_Core/` total size | <50KB | 🟡 WARN |
| Cold tier logging | Check cold tier for new event logs | >0 new log entries in last hour | 🟡 WARN |

### 2.4 — Progress & Stall Detection

| Check | Method | Pass Criteria | Severity |
|-------|--------|---------------|----------|
| Forward progress | Tasks completed in last hour vs tasks created | Completed ≥ 50% of created (steady state) | 🟠 MEDIUM |
| Agent stalling | Any agent with an active task but 0 tool calls in >15min | 0 stalled agents | 🔴 HIGH |
| Blocked task accumulation | Blocked tasks trending up over 3 consecutive checks | Not trending up | 🟡 WARN |
| Sprint velocity | Tasks done per hour (rolling 4hr average) | >0 (any progress) | 📊 INFO |
| Idle agents | Agents with no active task and no dispatch in >30min | Flag for investigation | 🟡 WARN |

### Tier 2 Output Format

```markdown
## Xray Process Audit — {timestamp}

**Overall Health:** 🟢 ON TRACK / 🟡 CONCERNS / 🔴 INTERVENTION NEEDED

### SDLC Compliance: 92%
- 12/13 tasks followed full state machine
- 1 task skipped code_review → flagged (AOF-xyz, agent: swe-backend)
- TDD evidence: 8/12 tasks had test-first commits

### Routing: ✅ Healthy
- 15 dispatches, 14 correctly routed (93%)
- 1 misroute: data task sent to frontend engineer (routing rule gap)
- 0 re-dispatch loops
- 2 handoff pairs completed successfully

### Memory Usage: 🟡 Low
- 3/5 active agents queried memory (swe-qa and swe-devops did not)
- 0 warm tier updates (⚠️ aggregation may not be running)
- Hot tier: 38KB (within limit)

### Progress: ✅ On Track
- Completed: 4 tasks/hr (target: >0)
- Created: 3 tasks/hr
- Blocked: 2 (stable, not trending up)
- 0 stalled agents
```

---

## Implementation Plan

### Phase 1: Tier 1 Cron (15-minute health check)

Create a cron job that SSHes into Mule, runs the health checks, and reports to Matrix.

```yaml
schedule: { kind: "every", everyMs: 900000 }  # 15 min
sessionTarget: "isolated"
payload:
  kind: "agentTurn"
  model: "anthropic-api/claude-haiku-4-5"
  message: "<full Tier 1 check instructions>"
delivery: { mode: "announce", channel: "matrix" }
```

**Implementation:** Single script that SSHes to Mule, runs all checks, formats report. Announce only on 🟡 DEGRADED or 🔴 CRITICAL (silent on green).

### Phase 2: Tier 2 Cron (1-hour process audit)

```yaml
schedule: { kind: "every", everyMs: 3600000 }  # 1 hour
sessionTarget: "isolated"
payload:
  kind: "agentTurn"
  model: "anthropic-api/claude-sonnet-4-6"
  message: "<full Tier 2 audit instructions>"
  timeoutSeconds: 300
delivery: { mode: "announce", channel: "matrix" }
```

**Implementation:** More complex — needs to read task files, parse event logs, check git history. Sonnet for reasoning capability.

### Phase 3: Dashboard Integration

Wire Tier 1/2 outputs into the existing metrics-bridge → Grafana pipeline for visual dashboards.

---

## Known Risks from Previous Xray Runs

| Issue | Lesson | Mitigation |
|-------|--------|------------|
| XRAY-001 | `sessions_spawn` blocked by default | Verify in Tier 1.3 tool access check |
| XRAY-002 | Plugin config key is `config` not `settings` | Verify plugin loaded in Tier 1.1 |
| XRAY-004 | Stale leases block re-dispatch | Fixed in code; verify in Tier 1.2 |
| XRAY-005 | Agents don't call `aof_task_complete` | Monitor completion rate in Tier 2.2 |
| Tool access regression | `allow` vs `alsoAllow` broke serena tools | Verify in Tier 1.3 every 15min |

---

## Success Criteria

Xray is **green** when:
1. All Tier 1 checks pass for 24 consecutive hours
2. SDLC compliance >90% over 4 hours
3. Task completion rate >60% of dispatches
4. 0 stuck tasks lasting >1 poll cycle
5. All agents have access to required tools (AOF + serena + exec)
