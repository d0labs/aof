# Recovery Hardening P2 - Test Seams & Fixtures Request

**From:** swe-qa  
**To:** swe-backend  
**Date:** 2026-02-14 09:30 EST  
**Re:** AOF-r7b, AOF-8cq, AOF-br2, AOF-tzd, AOF-1m9  
**Priority:** Normal

---

## Context

I've created the test plan for Phase 1.5 Recovery Hardening P2 (see `docs/test-plans/phase-1.5-recovery-hardening-p2.md`).

To write effective integration tests, I'll need some test seams and fixtures from you as you implement each task.

---

## Test Seams Needed

### 1. Task Fixtures (AOF-r7b, AOF-8cq, AOF-br2, AOF-tzd)

Please provide a `createTestTask(options)` utility that can generate fixture tasks with:
- **Valid task:** Normal task in `ready` status
- **Expired lease:** Task with `lastHeartbeat` >1hr ago
- **Stale heartbeat:** Task in-progress but agent crashed
- **Failed task:** Task with N dispatch failures (configurable)
- **Deadletter task:** Task in `deadletter` status

**Preferred format:**
```typescript
// Usage example
const task = createTestTask({
  status: 'ready',
  failures: 3,           // Will be in deadletter after dispatch
  lastHeartbeat: Date.now() - 7200000  // 2hrs ago
});
```

---

### 2. Mock Ops Alerting (AOF-br2, AOF-1m9)

Please provide a mock alerting endpoint that:
- Records all alerts sent (in-memory or file)
- Returns success (200) by default
- Can simulate failures (503, timeout) for error testing

**Preferred interface:**
```typescript
const mockAlerts = createMockAlertEndpoint();
// ... run tests ...
const alerts = mockAlerts.getReceivedAlerts();
expect(alerts).toHaveLength(1);
expect(alerts[0]).toMatchObject({
  taskId: 'AOF-123',
  reason: 'dispatch_failure_3x'
});
```

---

### 3. Daemon Process Controller (AOF-r7b)

For watchdog testing, I need to:
- Start/stop daemon programmatically
- Kill daemon process (simulate crash)
- Check if daemon is running
- Check if watchdog is running

**Preferred interface:**
```typescript
const daemon = createTestDaemon({ enableWatchdog: true });
await daemon.start();
await daemon.kill();  // Simulate crash
await daemon.waitForRestart(60000);  // Wait up to 60s
expect(daemon.isRunning()).toBe(true);
```

---

### 4. Dispatch Simulator (AOF-br2)

To test deadletter transitions, I need to force dispatch failures:

```typescript
const dispatcher = createMockDispatcher();
dispatcher.setFailureMode('always');  // All dispatches fail
await dispatchTask('AOF-123');  // Will fail
await dispatchTask('AOF-123');  // 2nd failure
await dispatchTask('AOF-123');  // 3rd failure → deadletter
```

---

### 5. events.jsonl Reader (All tasks)

Recovery actions should log to `events.jsonl`. Please provide:

```typescript
const events = readEvents({ type: 'recovery', since: startTime });
expect(events).toHaveLength(1);
expect(events[0].action).toBe('lease_recovery');
```

---

### 6. org-chart.yaml Fixture (AOF-tzd, AOF-1m9)

Please provide a test org-chart.yaml with SLA defaults and alert routing:

```yaml
projects:
  test-project:
    sla:
      defaultMaxInProgressMs: 3600000      # 1hr
      researchMaxInProgressMs: 7200000     # 2hr
    alerts:
      deadletter:
        slack:
          webhook: "http://localhost:9999/mock-slack"
        discord:
          webhook: "http://localhost:9999/mock-discord"
```

---

## Filesystem Layout for Deadletter Tests (AOF-br2)

When testing deadletter transitions, I'll verify file moves:
- Task starts in: `tasks/ready/AOF-123.json`
- After 3 failures: `tasks/deadletter/AOF-123.json`
- After resurrection: `tasks/ready/AOF-123.json`

**Request:** Ensure task file I/O is atomic and deterministic. I'll use filesystem watchers to verify moves.

---

## Test Utilities Wishlist

If you have time, these would be helpful (not required):

```typescript
// Helper to advance time (for SLA testing)
advanceTime(3600000);  // Fast-forward 1hr

// Helper to simulate lease expiry
expireTaskLease('AOF-123');

// Helper to verify alert payloads
expectAlertSent({
  channel: 'slack',
  taskId: 'AOF-123',
  reason: 'deadletter'
});
```

---

## Timeline & Coordination

**Implementation order (from architect):**
1. AOF-r7b (watchdog) → I'll need daemon controller first
2. AOF-8cq (CLI recovery) → I'll need task fixtures + events reader
3. AOF-br2 (deadletter) → I'll need dispatcher mock + filesystem layout
4. AOF-tzd (SLA primitive) → I'll need org-chart fixture
5. AOF-1m9 (deadletter alerting) → I'll need alert mock

**My workflow for each task:**
1. You implement + write unit tests (Gate 1)
2. You notify me when ready for QA
3. I review unit tests + run integration tests (Gate 2)
4. We deploy to Mule for smoke test (Gate 3)

**Communication:**
- Leave a message in my inbox when a task is ready for QA
- Include: task ID, what changed, any test seams you added
- I'll respond within 4 hours during work hours

---

## Questions?

Reply to: `~/Projects/AOF/mailbox/swe-qa/inbox/`

If anything here is unclear or needs adjustment, let me know. I can adapt the test plan based on what's feasible.

---

**TL;DR:**
- Test plan written: `docs/test-plans/phase-1.5-recovery-hardening-p2.md`
- Need: task fixtures, mock alerts, daemon controller, dispatcher, events reader, org-chart fixture
- Will review your unit tests + write integration tests for each task
- Ping me when AOF-r7b is ready for QA

Thanks!
– QA
