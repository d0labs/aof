# Task Brief: Daemon Health Monitoring (Watchdog Service)

**Beads Task ID:** AOF-kux  
**Priority:** Phase 1.5 Recovery Hardening  
**Assigned To:** swe-backend  
**Estimate:** 3 person-days  
**Dependencies:** None (ready to start)

---

## Objective

Implement daemon health check endpoint and optional watchdog plugin to prevent indefinite stalls when the AOF daemon crashes or hangs.

**Claim this task:** `bd update AOF-kux --claim --json`  
**View details:** `bd show AOF-kux --json`

---

## Context

PO approved Phase 1.5 Recovery Hardening (see `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md`). The Project Xray Sprint 1 stall exposed that AOF's recovery is daemon-dependent. If the daemon stops, tasks stall indefinitely with no external detection.

**Design Doc:** `~/Projects/AOF/docs/design/DAEMON-WATCHDOG-DESIGN.md` (READ THIS FIRST)

---

## Scope

### Files to Create
1. **src/daemon/health.ts** — Health check endpoint implementation
2. **plugins/watchdog/index.ts** — Watchdog plugin main logic
3. **plugins/watchdog/restart-tracker.ts** — Restart count tracking
4. **plugins/watchdog/alerting.ts** — Ops team alerts

### Files to Modify
1. **src/daemon/server.ts** — Register `/health` endpoint on daemon startup
2. **openclaw.plugin.json** — Register watchdog plugin hook (if needed)

### Configuration
- Add `daemon.watchdog` section to `org-chart.yaml` (see design doc)
- Watchdog is **disabled by default** (opt-in for OpenClaw deployments)

---

## Acceptance Criteria

### Health Endpoint
- [ ] `GET /health` returns 200 when daemon is healthy
- [ ] `GET /health` returns 503 when daemon is unhealthy
- [ ] Health response includes: `status`, `uptime`, `lastPollAt`, `lastEventAt`, `taskCounts`
- [ ] Health check runs in <50ms (no expensive operations)
- [ ] Endpoint is public (no auth required)

### Watchdog Plugin
- [ ] Watchdog polls `/health` every 60s
- [ ] On failure, restart daemon via `aof-daemon start` (subprocess)
- [ ] Track restart count (max 3 in 1hr window)
- [ ] After 3 restarts, alert ops team and stop retrying
- [ ] Restart history includes: timestamp, reason
- [ ] Watchdog only runs if `org-chart.yaml` has `daemon.watchdog.enabled: true`

### Alerting
- [ ] Alert message includes: restart history, daemon logs (last 100 lines), health status
- [ ] Alert destination: Slack/Discord/email (configurable via org-chart.yaml)
- [ ] Alert severity: `critical`

### Configuration
- [ ] `org-chart.yaml` schema includes `daemon.watchdog` section
- [ ] Defaults: `pollIntervalMs: 60000`, `maxRestarts: 3`, `windowMs: 3600000`

---

## Test Requirements

### Unit Tests (6 tests minimum)
1. Health endpoint returns 200 when scheduler is active
2. Health endpoint returns 503 when scheduler is stale (>5min since last poll)
3. RestartTracker correctly counts restarts within 1hr window
4. RestartTracker prunes old restarts outside window
5. Alert formatting includes all required metadata
6. Watchdog respects `enabled: false` config (does not start loop)

### Integration Tests (3 tests minimum)
1. Kill daemon process → watchdog detects failure → restarts daemon within 60s
2. Kill daemon 3 times → watchdog stops retrying and alerts ops team
3. Health endpoint survives high load (100 req/s for 10s)

**Test Framework:** vitest  
**Run Tests:** `cd ~/Projects/AOF && npx vitest run`

---

## Implementation Notes

### Health Check Logic
```typescript
function isHealthy(): boolean {
  const now = Date.now();
  const lastPoll = getDaemonState().lastPollAt;
  
  // If scheduler hasn't polled in 5min, daemon is unhealthy
  if (now - lastPoll > 5 * 60 * 1000) return false;
  
  // Try to read tasks directory (basic filesystem check)
  try {
    fs.readdirSync(path.join(process.cwd(), 'tasks'));
  } catch (err) {
    return false; // Can't read tasks → unhealthy
  }
  
  return true;
}
```

### Restart Logic
```typescript
async function restartDaemon(): Promise<void> {
  // 1. Kill existing daemon process (if running)
  // 2. Run: aof-daemon start (via child_process.spawn)
  // 3. Wait for /health to return 200 (with timeout)
  // 4. If restart fails, record failure and continue watchdog loop
}
```

### Rate Limiting
- Watchdog polls every 60s (no burst checking)
- Restart tracker uses sliding window (1hr)
- After window expires, restart count resets

---

## Out of Scope

- Dashboard UI for health status (CLI-only for Phase 1)
- Metrics export (Prometheus, Grafana)
- Configurable health check logic (hardcoded for Phase 1)
- Multi-daemon coordination (assumes single daemon per project)

---

## Definition of Done

1. All acceptance criteria met
2. All unit tests pass (`npx vitest run`)
3. All integration tests pass
4. Code reviewed by architect (tag @swe-architect in commit/PR)
5. Design doc updated if implementation deviates from spec
6. Task closed: `bd close AOF-kux --json`

---

## Questions?

If you need clarification, leave a message in my mailbox:  
`~/Projects/AOF/mailbox/swe-architect/inbox/re-aof-kux-question.md`

Include:
- What's unclear
- What decision you need
- Proposed options (if any)

I'll respond within 4 hours during work hours.

---

**START HERE:**
1. Read design doc: `~/Projects/AOF/docs/design/DAEMON-WATCHDOG-DESIGN.md`
2. Claim task: `bd update AOF-kux --claim --json`
3. Create `src/daemon/health.ts` (health endpoint first)
4. Write unit tests for health logic
5. Create `plugins/watchdog/` (watchdog plugin second)
6. Write integration test (kill daemon → restart)
7. Update `org-chart.yaml` with watchdog config
8. Close task: `bd close AOF-kux --json`

**Estimated Time:** 3 days  
**TDD:** Write tests before implementation (health tests → watchdog tests → integration tests)
