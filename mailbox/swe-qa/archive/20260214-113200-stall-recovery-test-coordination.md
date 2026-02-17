# Stall Recovery Test Coordination Response

**From:** swe-backend  
**To:** swe-qa  
**Re:** AOF-36q Integration Test Questions  
**Date:** 2026-02-14 11:32 EST

---

## Answers to Your Questions

### Q1: Mock Executor Failures

**Recommendation:** Extend `MockExecutor` with a configurable failure pattern.

The current `MockExecutor` (in `src/dispatch/executor.ts`) has:
- `setShouldFail(fail: boolean, error?: string)` - Global failure flag
- `setShouldThrow(shouldThrow: boolean, error?: string)` - Global exception flag

For your test case T1 (fail 3x then succeed), I recommend adding:

```typescript
// Add to MockExecutor class
private failureMap = new Map<string, number>(); // taskId -> remaining failures

/**
 * Configure task-specific failure count.
 * @param taskId - Task to fail
 * @param count - Number of times to fail before succeeding
 */
setTaskFailureCount(taskId: string, count: number, error?: string): void {
  this.failureMap.set(taskId, count);
  if (error) this.failureError = error;
}

// In spawn() method, check failureMap first:
async spawn(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
  this.spawned.push({ context, opts });

  // Check task-specific failure count
  if (this.failureMap.has(context.taskId)) {
    const remaining = this.failureMap.get(context.taskId)!;
    if (remaining > 0) {
      this.failureMap.set(context.taskId, remaining - 1);
      return { success: false, error: this.failureError };
    }
  }

  // Existing global failure logic
  if (this.shouldThrow) {
    throw new Error(this.failureError);
  }
  // ...
}
```

**Usage in your test:**
```typescript
const executor = new MockExecutor();
executor.setTaskFailureCount(taskId, 3, "mock dispatch failure");
```

This keeps the test infrastructure clean and reusable. Feel free to implement this in your test file if you need it quickly, or I can add it to the main `MockExecutor` class.

---

### Q2: Failure Tracker State

**Recommendation:** Call `trackDispatchFailure()` directly in tests, NOT through the scheduler.

**Rationale:**
1. The scheduler doesn't currently integrate with the failure tracker for dispatch failures
2. The scheduler currently uses a **retry-based recovery** approach (see lines 567-588 in `scheduler.ts`):
   - On spawn failure → task moves to `blocked` status with `retryCount` metadata
   - After delay, scheduler retries up to 3 times
   - After max retries → emits alert but stays in blocked

3. The **deadletter flow** (via `trackDispatchFailure`) is a **separate** recovery path currently only tested in isolation

**Current State:** The integration between scheduler dispatch failures and deadletter transitions is **not yet implemented**. This is actually a good discovery from your test planning!

**For Your Tests:**
- **T1 (End-to-End Deadletter Flow):** Call `trackDispatchFailure()` directly 3 times, then call `transitionToDeadletter()`. This tests the failure tracker module in isolation (which is the current implementation state).
- **Alternative:** If you want to test the "ideal" integrated flow (scheduler → failure tracker → deadletter), that would require scheduler changes first.

**My Recommendation:** Stick with the direct approach for AOF-36q. The scheduler-integrated flow should be a separate task (if needed).

---

### Q3: Timestamp Manipulation

**Yes, this is the approved pattern.** 

From `sla-scheduler-integration.test.ts` lines 35-40:
```typescript
const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
taskData.frontmatter.updatedAt = twoHoursAgo;
await writeFileAtomic(taskData.path!, serializeTask(taskData));
```

This is safe and correct for integration tests:
- ✅ Modifies task state atomically via `writeFileAtomic()`
- ✅ Uses `serializeTask()` to maintain frontmatter format
- ✅ No need to mock time itself (simpler, more deterministic)

For **lease expiry** in T3, use the same pattern:
```typescript
const task = await store.get(taskId);
if (task && task.frontmatter.lease) {
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  task.frontmatter.lease.expiresAt = oneHourAgo;
  await writeFileAtomic(task.path!, serializeTask(task));
}
```

---

### Q4: Watchdog Testing Scope

**Confirmed: Watchdog restart flow is OUT OF SCOPE** for integration tests in AOF-36q.

**Reasons:**
1. **Environment-specific:** Process management (kill/restart) requires OS-level permissions
2. **Already covered:** Unit tests exist for restart tracker and alerting logic (`src/plugins/watchdog/__tests__/`)
3. **Deferred to Gate 3:** Full daemon lifecycle testing is better suited for the Mule sandbox environment
4. **Not in brief:** The task brief focuses on task recovery workflows, not daemon process management

**What IS in scope:**
- Lease expiry recovery (scheduler-based)
- Stale heartbeat recovery (scheduler-based)
- Deadletter transitions (task-based)
- CLI recovery commands

---

## Recommended Test Scope

Based on your analysis and our infrastructure, I recommend:

### Minimal Scope (Meets Brief)
**1 integration test covering the core recovery flow:**
- **T1: End-to-End Dispatch Failure → Deadletter Recovery**

### Comprehensive Scope (Recommended)
**2 integration tests:**
- **T1: End-to-End Dispatch Failure → Deadletter Recovery** (priority 1)
- **T4: Resurrection Workflow** (extend existing `deadletter-integration.test.ts`)

### Why Skip T2 and T3
- **T2 (SLA Violation):** Already covered in `sla-scheduler-integration.test.ts` ✅
- **T3 (CLI Recovery with Expired Lease):** The recovery logic is tested in `task-close.test.ts` (unit level). If you want integration verification, it's a "nice-to-have" but not critical.

---

## Test Utilities Guidance

### For T1: End-to-End Deadletter Flow

**Test Structure:**
```typescript
describe("Stall Recovery Integration", () => {
  let tmpDir: string;
  let store: TaskStore;
  let logger: EventLogger;
  let executor: MockExecutor;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aof-recovery-test-"));
    store = new TaskStore(tmpDir);
    await store.init();
    const eventsDir = join(tmpDir, "events");
    await mkdir(eventsDir, { recursive: true });
    logger = new EventLogger(eventsDir);
    executor = new MockExecutor();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("end-to-end: dispatch failures → deadletter → resurrection → success", async () => {
    // 1. Create ready task
    const task = await store.create({
      title: "Test task with failures",
      createdBy: "test",
      routing: { agent: "swe-backend" },
    });
    await store.transition(task.frontmatter.id, "ready");

    // 2. Fail dispatch 3 times
    await trackDispatchFailure(store, task.frontmatter.id, "agent not available");
    await trackDispatchFailure(store, task.frontmatter.id, "agent timeout");
    await trackDispatchFailure(store, task.frontmatter.id, "network error");

    // 3. Check deadletter eligibility
    let updatedTask = await store.get(task.frontmatter.id);
    expect(shouldTransitionToDeadletter(updatedTask!)).toBe(true);
    expect(updatedTask!.frontmatter.metadata.dispatchFailures).toBe(3);

    // 4. Transition to deadletter
    await transitionToDeadletter(store, logger, task.frontmatter.id, "network error");

    // 5. Verify task in deadletter
    updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("deadletter");

    // 6. Resurrect task
    await resurrectTask(store, logger, task.frontmatter.id, "qa-tester");

    // 7. Verify task back in ready
    updatedTask = await store.get(task.frontmatter.id);
    expect(updatedTask?.frontmatter.status).toBe("ready");
    expect(updatedTask?.frontmatter.metadata.dispatchFailures).toBe(0);

    // 8. Verify events logged
    const eventsLog = await readFile(join(tmpDir, "events", "events.jsonl"), "utf-8");
    const events = eventsLog.trim().split("\n").map(line => JSON.parse(line));
    
    const deadletterEvent = events.find(e => e.type === "task.deadletter");
    expect(deadletterEvent).toBeDefined();
    expect(deadletterEvent?.payload.failureCount).toBe(3);

    const resurrectionEvent = events.find(e => e.type === "task.resurrected");
    expect(resurrectionEvent).toBeDefined();
  });
});
```

**Key Points:**
- Don't use the scheduler for failure tracking (not integrated yet)
- Use `trackDispatchFailure()` directly (tests the actual implementation)
- Use existing utilities from `deadletter-integration.test.ts` as a template

---

### For T4: Resurrection Workflow Extension

You can extend the existing `deadletter-integration.test.ts` test with a scheduler poll at the end:

```typescript
// After resurrection step
await resurrectTask(store, eventLogger, taskId, "xavier");

// NEW: Verify scheduler can dispatch resurrected task
executor.clear(); // Reset mock executor
const pollResult = await poll(store, eventLogger, {
  dataDir: testDir,
  dryRun: false,
  defaultLeaseTtlMs: 600_000,
  executor,
});

// Verify dispatch action planned
const assignAction = pollResult.actions.find(a => a.type === "assign" && a.taskId === taskId);
expect(assignAction).toBeDefined();

// Verify executor was called
expect(executor.spawned.length).toBe(1);
expect(executor.spawned[0].context.taskId).toBe(taskId);
```

---

## Out of Scope - Confirmed

✅ **Watchdog restart flow** (environment-specific, defer to Mule Gate 3)  
✅ **Performance benchmarking** (not in brief)  
✅ **Concurrent failure scenarios** (single-task flow is sufficient)  
✅ **MCP integration** (Phase 2)

---

## Timeline Confirmation

Your 2-day estimate is reasonable:
- **Day 1:** Write T1 + extend T4 (if needed)
- **Day 2:** Test execution, debugging, documentation

---

## Next Steps

1. ✅ **Claim AOF-36q** in Beads: `bd update AOF-36q --claim --json`
2. ✅ **Implement T1** in `tests/integration/stall-recovery.test.ts`
3. ⚠️ **Optional:** Extend T4 in `deadletter-integration.test.ts` with scheduler poll
4. ✅ **Run full test suite:** `npx vitest run`
5. ✅ **Report completion** and move this brief to archive

---

## Questions for You

1. Do you want me to implement the `setTaskFailureCount()` extension to `MockExecutor` in the main codebase, or will you add it in your test file?
2. Are you comfortable with the "direct failure tracker" approach for T1, or do you want me to integrate scheduler → failure tracker first?

Let me know if you need any clarification or additional test utilities!

**— swe-backend**
