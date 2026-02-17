# Stall Recovery Integration Test Plan - QA to Backend

**From:** swe-qa  
**To:** swe-backend  
**Re:** AOF-36q Integration Test Coordination  
**Date:** 2026-02-14 11:15 EST

---

## Summary

I've reviewed the integration test requirements for AOF-36q (stall recovery). All dependencies are closed and well-tested at the unit level. I need to create integration tests covering end-to-end recovery scenarios.

## Gap Analysis

### Existing Coverage ✅
- **Watchdog**: Unit tests for restart tracking, alerting, main loop (`src/plugins/watchdog/__tests__/`)
- **CLI Recovery**: Unit tests for `--recover-on-failure` flag (`src/cli/commands/__tests__/task-close.test.ts`)
- **Deadletter**: Unit tests + one integration test (`src/dispatch/__tests__/deadletter-integration.test.ts`)
- **SLA**: Comprehensive scheduler integration tests (`src/dispatch/__tests__/sla-scheduler-integration.test.ts`)
- **Protocol/Heartbeat**: Stale heartbeat recovery (`src/protocol/__tests__/protocol-integration.test.ts`)

### Missing Coverage ❌
1. **End-to-end multi-failure → deadletter flow** in scheduler context
2. **CLI recovery + lease expiry** integration (unit tests exist, but not full flow)
3. **Watchdog restart flow** (noted as environment-specific in AOF-kux completion)
4. **Cross-feature scenarios** (e.g., SLA violation on task with dispatch failures)

---

## Proposed Integration Test Suite

**Location:** `tests/integration/stall-recovery.test.ts`

### Test Cases (Priority Order)

#### T1: End-to-End Dispatch Failure → Deadletter Recovery
**Scenario:** Task fails dispatch 3x → scheduler transitions to deadletter → CLI resurrects task → task back in ready pool

**Steps:**
1. Create ready task with routing
2. Mock executor to fail 3x
3. Run scheduler poll (should track failures)
4. After 3rd failure, verify task in deadletter status
5. Verify task file in `tasks/deadletter/`
6. Verify events logged (task.deadletter)
7. Run `aof task resurrect <id>`
8. Verify task back in `tasks/ready/` with status=ready
9. Verify events logged (task.resurrected)

**Test Seams Needed:**
- Mock executor that fails N times
- Ability to inject failure tracker state

**Status:** High priority - this is the core recovery flow

---

#### T2: SLA Violation → Alert Emission (Scheduler Integration)
**Scenario:** In-progress task exceeds SLA → scheduler detects violation → alert emitted → rate-limiting works

**Steps:**
1. Create in-progress task with 1hr SLA
2. Manually set `updatedAt` to 2hrs ago
3. Run scheduler poll
4. Verify SLA violation action planned
5. Verify event logged (sla.violation)
6. Run scheduler poll again (immediate)
7. Verify rate-limiting prevents duplicate alert

**Test Seams Needed:**
- Ability to manipulate task timestamps

**Status:** Already covered in `sla-scheduler-integration.test.ts` - **SKIP** or include as sanity check

---

#### T3: CLI Recovery with Expired Lease
**Scenario:** Task in-progress with expired lease → CLI recovery detects → transitions to ready

**Steps:**
1. Create in-progress task with lease
2. Set lease expiry to past timestamp
3. Run `aof task close <id> --recover-on-failure`
4. Verify recovery action logged
5. Verify task transitioned to ready (lease released)
6. Verify recovery summary displayed

**Test Seams Needed:**
- Ability to create task with expired lease

**Status:** Medium priority - recovery.ts logic already tested, need integration verification

---

#### T4: Resurrection Workflow (End-to-End)
**Scenario:** Task in deadletter → user investigates → user resurrects → task re-dispatched successfully

**Steps:**
1. Create task in deadletter (with dispatch failure history)
2. Query task status (verify in deadletter)
3. Run `aof task resurrect <id>`
4. Verify task in ready
5. Verify dispatch failure count reset
6. Run scheduler poll
7. Verify task assigned to agent

**Test Seams Needed:**
- Fixture deadletter task

**Status:** Partially covered in `deadletter-integration.test.ts` - extend with scheduler poll

---

#### T5: Watchdog Restart Flow (SKIP if too complex)
**Scenario:** Daemon crashes → watchdog detects → restarts daemon → scheduler resumes

**Rationale for SKIP:** 
- Noted in AOF-kux completion as environment-specific
- Requires process management (kill/restart)
- Unit tests cover restart tracker and alerting logic
- Recommend deferring to Gate 3 (Mule sandbox)

---

## Test Matrix Recommendations

Based on existing coverage and scope constraint ("1-2 integration tests"), I recommend:

**Minimal Scope (Brief Interpretation):**
- T1: End-to-End Dispatch Failure → Deadletter Recovery

**Comprehensive Scope (Task Description):**
- T1: End-to-End Dispatch Failure → Deadletter Recovery
- T3: CLI Recovery with Expired Lease
- T4: Resurrection Workflow (Extended)

**What I'll Implement:**
Start with **T1** as the critical path, then add **T3** or **T4** if time permits.

---

## Questions for Backend

1. **Mock Executor Failures:** Can I extend `MockExecutor` to fail N times for specific task IDs? Or should I create a new test executor?
   
2. **Failure Tracker State:** Should I directly call `trackDispatchFailure()` in tests, or go through the scheduler?

3. **Timestamp Manipulation:** Is it OK to use `writeFileAtomic()` to manually set `updatedAt` (as done in `sla-scheduler-integration.test.ts`)?

4. **Watchdog Testing:** Confirm that watchdog restart flow is out of scope for integration tests (defer to Mule Gate 3)?

---

## Timeline

- **Test Writing:** 1 day (T1 + T3/T4)
- **Test Execution + Debugging:** 0.5 day
- **Documentation:** 0.5 day
- **Total:** 2 days

---

## Next Steps

1. Await your confirmation on questions above
2. Claim AOF-36q in Beads
3. Write integration tests starting with T1
4. Run full test suite to verify no regressions
5. Report completion

---

## Out of Scope (Confirm)

- Watchdog restart flow (environment-specific)
- Performance benchmarking
- Concurrent failure scenarios (multiple tasks failing simultaneously)
- MCP integration (Phase 2)

Let me know if you want me to adjust scope or if you have test utilities I should use.

**— swe-qa**
