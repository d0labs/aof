# Test Plan: Phase 1.5 Recovery Hardening (P2)

**Date:** 2026-02-14  
**QA Lead:** swe-qa  
**Tasks:** AOF-r7b, AOF-8cq, AOF-br2, AOF-tzd, AOF-1m9  
**Backend Coordination:** Required

---

## Objective

Validate recovery hardening features (watchdog, recovery hooks, deadletter, SLA, alerting) with focus on:
1. **No behavior change when features disabled** (backward compatibility)
2. **Opt-in behavior works correctly when enabled**
3. **Failure/recovery scenarios** (state transitions, error handling)
4. **Schema/data compatibility** (serialization, defaults, migrations)

---

## Test Matrix

### Feature Dimensions
- **Default (disabled):** No opt-in flags → existing behavior preserved
- **Opt-in (enabled):** Feature flags set → new behavior active
- **Failure scenarios:** Process crashes, timeouts, state corruption
- **Edge cases:** Rate limits, boundary conditions, concurrent operations

---

## Test Coverage by Task

### AOF-r7b: Daemon Health Monitoring (Watchdog)

**Acceptance Criteria:**
- Watchdog enabled vs. disabled → no behavior change when disabled
- Daemon crashes → watchdog restarts within 60s (when enabled)
- 3 crashes in 1hr → watchdog stops and alerts ops team
- Clean shutdown → watchdog does not restart daemon

**Test Cases:**

| ID | Scenario | Input | Expected Output | Type |
|----|----------|-------|-----------------|------|
| W1 | Watchdog disabled (default) | Daemon runs normally | No watchdog process spawned | Unit |
| W2 | Watchdog enabled | `--enable-watchdog` flag | Watchdog monitors daemon health | Unit |
| W3 | Daemon crash (1st time) | Kill daemon process | Watchdog restarts within 60s | Integration |
| W4 | Daemon crash (3rd in 1hr) | Kill daemon 3x in 1hr | Watchdog stops, alert emitted | Integration |
| W5 | Clean shutdown | `aof daemon stop` | Watchdog exits cleanly, no restart | Integration |
| W6 | Watchdog crash | Kill watchdog process | Daemon continues running | Integration |
| W7 | Health endpoint | `curl /health` when enabled | Returns `{"status": "ok", "uptime": N}` | Unit |
| W8 | Health endpoint (disabled) | `curl /health` when disabled | 404 or endpoint not available | Unit |

**Test Seams Needed:**
- Controllable daemon process (can kill/restart)
- Watchdog config file (enable/disable, retry limits)
- Mock ops alerting endpoint

---

### AOF-8cq: CLI Recovery Hooks (`--recover-on-failure`)

**Acceptance Criteria:**
- Flag absent → no recovery behavior (existing behavior)
- Flag present → check lease expiry, heartbeat staleness, log recovery actions
- Recovery actions logged to `events.jsonl`
- User sees recovery summary

**Test Cases:**

| ID | Scenario | Input | Expected Output | Type |
|----|----------|-------|-----------------|------|
| R1 | No recovery flag (default) | `aof task close AOF-123` | Standard close, no recovery checks | Unit |
| R2 | Recovery flag + expired lease | `aof task close AOF-123 --recover-on-failure` | Task transitioned to `ready`, recovery logged | Integration |
| R3 | Recovery flag + stale heartbeat | Task heartbeat >1hr old, `--recover-on-failure` | Artifact marked expired, logged | Integration |
| R4 | Recovery flag + valid task | Task is healthy, `--recover-on-failure` | No recovery action, logged as "no action needed" | Integration |
| R5 | Recovery summary display | `--recover-on-failure` triggers recovery | CLI prints recovery summary (what was recovered) | Integration |
| R6 | events.jsonl logging | Any recovery action | Entry in `events.jsonl` with `type: recovery` | Integration |

**Test Seams Needed:**
- Mock task with expired lease (fixture)
- Mock task with stale heartbeat (fixture)
- events.jsonl reader/parser

---

### AOF-br2: Deadletter Status + Resurrection

**Acceptance Criteria:**
- 3 dispatch failures → task transitions to `deadletter` status
- Task file moved to `tasks/deadletter/`
- `aof task resurrect <id>` → task back to `ready`
- Guards prevent accidental resurrection (confirmation required)
- Alert emitted on deadletter transition

**Test Cases:**

| ID | Scenario | Input | Expected Output | Type |
|----|----------|-------|-----------------|------|
| D1 | Single dispatch failure | Task fails 1x | Status remains `ready`, retry scheduled | Unit |
| D2 | 3 dispatch failures | Task fails 3x | Status → `deadletter`, file moved to `tasks/deadletter/` | Integration |
| D3 | Deadletter transition alert | Task → deadletter | Ops alert emitted with task ID, title, reason | Integration |
| D4 | Resurrection command | `aof task resurrect AOF-123` | Task status → `ready`, file moved to `tasks/ready/` | Integration |
| D5 | Resurrection with confirmation | `aof task resurrect AOF-123` (first time) | Prompts for confirmation before resurrection | Integration |
| D6 | Resurrection force flag | `aof task resurrect AOF-123 --force` | Skips confirmation, resurrects immediately | Integration |
| D7 | Resurrection of non-deadletter task | `aof task resurrect AOF-123` (task is `ready`) | Error: "Task is not in deadletter status" | Unit |
| D8 | events.jsonl logging | Deadletter transition + resurrection | Both events logged with timestamps | Integration |

**Test Seams Needed:**
- Fixture for task with 3 failures
- Mock dispatch function (can force failures)
- Ops alerting mock
- Filesystem watcher (verify file moves)

---

### AOF-tzd: SLA Primitive (Schema)

**Acceptance Criteria:**
- Schema validation: `maxInProgressMs`, `defaultMaxInProgressMs`, `researchMaxInProgressMs`, `onViolation`
- Defaults applied when fields absent
- Serialization preserves SLA fields
- Backward compatibility (old tasks without SLA fields still load)

**Test Cases:**

| ID | Scenario | Input | Expected Output | Type |
|----|----------|-------|-----------------|------|
| S1 | Task without SLA fields | Old task file (no SLA fields) | Loads successfully, uses project defaults | Unit |
| S2 | Task with SLA override | Task file with `maxInProgressMs: 3600000` | SLA limit is 1hr (overrides project default) | Unit |
| S3 | Project defaults (org-chart.yaml) | `defaultMaxInProgressMs: 7200000` | Tasks inherit 2hr default | Unit |
| S4 | Research task defaults | Task type `research`, `researchMaxInProgressMs: 14400000` | Uses 4hr limit instead of default | Unit |
| S5 | Invalid SLA value | `maxInProgressMs: -1` | Validation error, task creation fails | Unit |
| S6 | onViolation policy | `onViolation: "alert"` | Stored and retrieved correctly | Unit |
| S7 | Serialization round-trip | Task with SLA → save → load → check | All SLA fields preserved | Unit |
| S8 | Missing onViolation (default) | Task without `onViolation` | Defaults to `"alert"` | Unit |

**Test Seams Needed:**
- Fixture tasks with/without SLA fields
- Mock org-chart.yaml with SLA defaults
- Schema validator (can check for validation errors)

---

### AOF-1m9: Deadletter Alerting

**Acceptance Criteria:**
- Alert emitted ONLY when task transitions to deadletter
- Alert payload includes: task ID, title, failure reason, retry history
- Alert routing configurable via org-chart.yaml
- Alert is mandatory (cannot be disabled)

**Test Cases:**

| ID | Scenario | Input | Expected Output | Type |
|----|----------|-------|-----------------|------|
| A1 | Deadletter transition | Task → deadletter | Alert emitted with task metadata | Integration |
| A2 | Alert payload validation | Deadletter transition | Alert contains: id, title, reason, retry history | Integration |
| A3 | Alert routing (Slack) | `org-chart.yaml` → Slack webhook | Alert posted to Slack channel | Integration |
| A4 | Alert routing (Discord) | `org-chart.yaml` → Discord webhook | Alert posted to Discord channel | Integration |
| A5 | Alert routing (email) | `org-chart.yaml` → email config | Alert sent to ops email | Integration |
| A6 | No alert on other transitions | Task → ready, in-progress, done | No deadletter alert emitted | Unit |
| A7 | Alert cannot be disabled | Missing alert config in org-chart.yaml | Alert still emitted (fallback: console log) | Integration |

**Test Seams Needed:**
- Mock Slack/Discord/email endpoints
- org-chart.yaml fixture with alert routing
- Deadletter transition trigger (can force task to deadletter)

---

## Negative Test Cases (Minimum 2 per Feature)

### Watchdog
- **N1:** Watchdog enabled but daemon never crashes → no spurious restarts
- **N2:** Watchdog config file corrupted → watchdog fails gracefully, logs error

### Recovery Hooks
- **N3:** `--recover-on-failure` on non-existent task → error message, no crash
- **N4:** `--recover-on-failure` on task with invalid state → error message, no state corruption

### Deadletter
- **N5:** Resurrect non-existent task → error message, no crash
- **N6:** Resurrect already-resurrected task → idempotent (no-op or error)

### SLA
- **N7:** SLA value exceeds max int64 → validation error
- **N8:** Malformed org-chart.yaml SLA section → uses hardcoded defaults, logs warning

### Alerting
- **N9:** Alert endpoint unreachable → retry logic, fallback logging
- **N10:** Alert payload too large → truncate/summary, still deliver

---

## Test Execution Plan

### Phase 1: Unit Tests (per task)
1. Backend implements task
2. Backend writes unit tests (Gate 1)
3. QA reviews unit test coverage

### Phase 2: Integration Tests (cross-task)
1. QA writes integration tests in `tests/integration/recovery-hardening.test.ts`
2. Run locally: `cd ~/Projects/AOF && npx vitest run tests/integration/recovery-hardening.test.ts`
3. Verify all 5 features work together (Gate 2)

### Phase 3: Staging (end-to-end)
1. Deploy to staging environment
2. Run smoke test covering all features
3. Verify no production regressions (Gate 3)

---

## Dependencies & Coordination

### Backend Implementation Order (from brief)
1. AOF-r7b (watchdog) → Foundation for process monitoring
2. AOF-8cq (CLI recovery) → Builds on watchdog health checks
3. AOF-br2 (deadletter) → Requires dispatch retry logic
4. AOF-tzd (SLA primitive) → Schema foundation for alerting
5. AOF-1m9 (deadletter alerting) → Requires br2 + tzd

### Test Seams Required from Backend

**Minimal Fixtures:**
- Task files: valid, expired lease, stale heartbeat, 3 failures, deadletter
- org-chart.yaml: SLA defaults, alert routing
- events.jsonl: readable/parsable

**Mocks/Stubs:**
- Ops alerting endpoint (Slack/Discord/email)
- Daemon process controller (can start/stop/kill)
- Dispatch function (can force failures)

**Test Utilities:**
- `createTestTask(options)` → fixture task
- `simulateDaemonCrash()` → kill daemon process
- `simulateDispatchFailure(taskId, count)` → force N failures
- `readEvents()` → parse events.jsonl
- `getTaskStatus(taskId)` → query task state

### Coordination Message to Backend

I'll send a message to swe-backend with:
- Test seams needed (listed above)
- Request for test utilities
- Preferred fixture format (JSON examples)

---

## Estimated Test Count

- **Unit tests:** 8 (W1-W2, R1, D7, S1-S8) = ~12 unit tests
- **Integration tests:** 25+ (W3-W6, R2-R6, D2-D8, A1-A7, N1-N10)
- **Total:** ~35-40 tests

**Effort estimate:** 
- Test writing: 2-3 days
- Test execution + bug fixes: 1-2 days
- **Total:** 3-5 days (within brief's 10-15 test estimate, accounting for complexity)

---

## Out of Scope (Deferred to P3)
- MCP integrations
- Performance benchmarking
- Load testing
- Multi-tenant scenarios

---

## Success Criteria

- [ ] All 5 tasks pass unit tests (Gate 1)
- [ ] Integration tests pass locally (Gate 2)
- [ ] Smoke tests pass on staging (Gate 3)
- [ ] No regressions in existing test suite
- [ ] Test coverage: >80% for new code paths
- [ ] Negative cases covered (minimum 2 per feature)

---

## Questions for Architect (if any)

- None at this time. Test matrix is clear from brief.

---

**Next Steps:**
1. Send coordination message to backend (test seams + fixtures)
2. Wait for backend to implement AOF-r7b (first task)
3. Review backend's unit tests
4. Begin integration test writing
