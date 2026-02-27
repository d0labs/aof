# Security Remediation Design — AOF Protocols Primitive

**Date:** 2026-02-10  
**Scope:** Protocol router + protocol schemas + related tests  
**Findings:** SEC-001, SEC-002, SEC-003 (Gate 3 blockers)

---

## Summary of Decisions

| Finding | Decision | Notes |
|---|---|---|
| SEC-001 Missing Agent Authorization | **Accept (with minor modifications)** | Enforce `fromAgent` matches task assignment. Reject if unassigned or mismatch; log reason. |
| SEC-002 Race Condition in Concurrent Protocol Messages | **Accept** | Add in-memory task-level lock manager; wrap protocol handlers. |
| SEC-003 Unbounded Payloads / DoS | **Accept (with explicit limits)** | Add `.max()` constraints to protocol schemas; centralize limits as constants. |

---

## SEC-001 — Missing Agent Authorization (Critical)

### Decision
**Accept** the security suggestion with one clarifying rule: if a task has **no assigned agent** (no lease and no routing.agent), the protocol message is rejected as unauthorized to avoid spoofing.

### Rationale
- Completion/handoff messages mutate state and write artifacts. Without authorization checks, any agent can manipulate any task.
- In the current system, the authoritative assignment is in `frontmatter.lease.agent` (when in-progress) or `frontmatter.routing.agent` (explicit assignee). If neither is present, the system cannot authenticate the sender.

### Proposed Logic
In `src/protocol/router.ts`:
- Add a helper to resolve the assigned agent:
  - `task.frontmatter.lease?.agent ?? task.frontmatter.routing.agent`
- Add a shared authorization guard used in:
  - `handleCompletionReport`
  - `handleHandoffRequest`
  - `handleHandoffAck`
- If the assigned agent is missing or does not match `envelope.fromAgent`, log `protocol.message.rejected` with `reason: "unauthorized_agent"` (or `"unassigned_task"` when missing) and return without side effects.

### Specific Code Changes
- **File:** `src/protocol/router.ts`
  - New private helper (or local function) e.g. `assertAuthorizedAgent(task, envelope): boolean`.
  - Call guard early after loading the task but before writing artifacts or transitioning.
  - Log rejections in the same style as `task_not_found` rejections.

### Tests Required
- **New tests** in `src/protocol/__tests__/completion-status.test.ts` and `src/protocol/__tests__/protocol-integration.test.ts`:
  - Reject completion report when `fromAgent` ≠ assigned agent (no run_result written, no transitions).
  - Reject handoff.request when `fromAgent` ≠ assigned agent.
  - Reject handoff.accepted/rejected when `fromAgent` ≠ assigned agent.
  - Reject when task has no lease and no routing.agent (explicit “unassigned” rejection).
- **Update existing tests** to set assignment:
  - Ensure tasks under test have `routing.agent` set **or** acquire a lease before sending protocol messages.

### Edge Cases / Concerns
- **Status updates remain unauthenticated** in this change set (out of scope for SEC-001). Consider extending the same guard later to `handleStatusUpdate` to prevent unauthorized status mutations.
- Existing test helpers create in-progress tasks without leases; those must be updated to avoid false failures.

---

## SEC-002 — Race Condition in Concurrent Protocol Messages (High)

### Decision
**Accept** the security suggestion: implement a task-level in-memory lock manager and wrap protocol handlers.

### Rationale
- Protocol handlers load task state, write run artifacts, and transition status without synchronization.
- Two concurrent messages for the same task can interleave, producing inconsistent state or overwritten artifacts.
- Single-process runtime allows simple in-memory locking.

### Proposed Design
Introduce a lock manager:

```ts
export interface TaskLockManager {
  withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T>;
}
```

Implementation:
- **Class:** `InMemoryTaskLockManager`
- **Behavior:** queue per `taskId` (promise chain), ensure `finally` releases lock.
- **Scope:** only in-memory; no distributed locking.

### Specific Code Changes
- **New file:** `src/protocol/task-lock.ts` (or `src/protocol/lock-manager.ts`)
  - Export `TaskLockManager` interface + `InMemoryTaskLockManager` implementation.
- **File:** `src/protocol/router.ts`
  - Extend `ProtocolRouterDependencies` to accept optional `lockManager`.
  - Default to a new `InMemoryTaskLockManager` if none provided.
  - Wrap these handlers in `withLock(taskId, fn)`:
    - `handleCompletionReport`
    - `handleStatusUpdate`
    - `handleHandoffRequest`
    - `handleHandoffAck`

### Tests Required
- **New tests** in protocol router tests:
  - Simulate two concurrent completion reports for the same task; ensure the handler executes serially (no corrupted run_result, transitions deterministic).
  - A concurrency helper (barrier/deferred) to force overlap and confirm ordering.
- **Regression**: verify unrelated tasks still process concurrently (optional perf test).

### Edge Cases / Concerns
- If `handleSessionEnd` runs concurrently with protocol messages, it is still possible to interleave updates. Consider applying lock there as a follow-up.
- Ensure lock cleanup on errors to avoid deadlocks.

---

## SEC-003 — Unbounded Payloads / DoS (Medium)

### Decision
**Accept** the security suggestion with explicit limits sized for typical protocol payloads.

### Rationale
- Payload fields currently accept unbounded strings/arrays and are written to disk.
- Even a single large message could bloat `run_result.json` or handoff artifacts.

### Proposed Limits (Initial)
Centralize limits as constants near the schemas (tune later if needed):

| Field | Limit |
|---|---|
| `summaryRef` | 256 chars |
| `notes` | 10,000 chars |
| `deliverables[]` | max 50 items; each ≤ 256 chars |
| `blockers[]` | max 20 items; each ≤ 256 chars |
| `contextRefs[]` | max 50 items; each ≤ 256 chars |
| `acceptanceCriteria[]` | max 50 items; each ≤ 256 chars |
| `expectedOutputs[]` | max 50 items; each ≤ 256 chars |
| `constraints[]` | max 50 items; each ≤ 256 chars |
| `progress` | 1,000 chars |
| `reason` (handoff ack) | 512 chars |

### Specific Code Changes
- **File:** `src/schemas/protocol.ts`
  - Add constants for the limits.
  - Apply `.max()` to string fields and `.max()` + `.max()`-per-item to arrays.
  - Apply to `CompletionReportPayload`, `StatusUpdatePayload`, `HandoffRequestPayload`, `HandoffAckPayload` as appropriate.

### Tests Required
- **Schema tests** in `src/schemas/__tests__/protocol.test.ts`:
  - Add positive cases at boundary.
  - Add negative cases for strings/arrays exceeding limits.

### Edge Cases / Concerns
- If downstream users rely on larger notes, this is a breaking change; document limits in protocol docs and user guide.

---

## Cross-Cutting Testing Notes

- Update protocol integration tests to create tasks with `routing.agent` or an active lease, since authorization checks will now enforce assignment.
- Expect new tests to increase count beyond current 986 passing.

---

## Files & Interfaces Summary

**New files**
- `src/protocol/task-lock.ts` (TaskLockManager + InMemoryTaskLockManager)

**Modified files**
- `src/protocol/router.ts` (authorization guard + lock wrapping + dependency injection)
- `src/schemas/protocol.ts` (payload limits)
- `src/schemas/__tests__/protocol.test.ts` (limit tests)
- `src/protocol/__tests__/completion-status.test.ts` (authorization tests + updated setup)
- `src/protocol/__tests__/protocol-integration.test.ts` (authorization tests + updated setup)

---

## Open Questions
- Should `handleStatusUpdate` be guarded by the same authorization rules? (Recommended but not part of SEC-001 scope.)
- Do we need to include `frontmatter.metadata.assignee` as a fallback for authorization? (Currently only documented; not in schema.)
