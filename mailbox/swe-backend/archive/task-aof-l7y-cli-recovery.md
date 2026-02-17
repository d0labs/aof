# Task Brief: CLI Recovery Hooks (--recover-on-failure)

**Beads Task ID:** AOF-l7y  
**Priority:** Phase 1.5 Recovery Hardening  
**Assigned To:** swe-backend  
**Estimate:** 2 person-days  
**Dependencies:** None (ready to start)

---

## Objective

Add `--recover-on-failure` flag to CLI commands. On failure, check lease expiry and heartbeat staleness, log recovery actions to events.jsonl, display recovery summary to user. Opt-in for Phase 1.5.

**Claim this task:** `bd update AOF-l7y --claim --json`  
**View details:** `bd show AOF-l7y --json`

---

## Context

PO approved Phase 1.5 Recovery Hardening (see `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md` §2). CLI commands can fail if leases are stale or heartbeats expired. Recovery hooks check system state and attempt to repair before returning error to user.

**Requirements Section:** §2 + §5.2 in recovery-requirements.md

---

## Scope

### Files to Create
1. **src/cli/recovery.ts** — Recovery logic (lease/heartbeat checks)
2. **src/cli/recovery-formatter.ts** — User-facing recovery summary

### Files to Modify
1. **src/cli/commands/task-close.ts** — Add `--recover-on-failure` flag
2. **src/cli/commands/task-update.ts** — Add `--recover-on-failure` flag
3. **src/cli/commands/task-claim.ts** — Add `--recover-on-failure` flag
4. **src/events.ts** — Add recovery event types

---

## Acceptance Criteria

### CLI Flag
- [ ] `--recover-on-failure` flag available on: `task close`, `task update`, `task claim`
- [ ] Flag is opt-in (default: false)
- [ ] If flag is not present, commands behave as before (no recovery)

### Recovery Logic
- [ ] On failure, check if lease is expired (TTL exceeded)
- [ ] On failure, check if heartbeat is stale (>10min since last heartbeat)
- [ ] If lease expired → expire lease and reclaim task to `ready`
- [ ] If heartbeat stale → mark artifact expired
- [ ] Log recovery actions to `events.jsonl` with type: `recovery_action`
- [ ] Display recovery summary to user (stdout)

### Recovery Output Format
```bash
$ aof task close AOF-123 --recover-on-failure
❌ Failed to close AOF-123: file locked by process 12345
🔧 Recovery triggered:
   - Lease expired (10min TTL exceeded)
   - Task reclaimed to ready
   - Run artifact marked expired
✅ Task AOF-123 is now ready for re-dispatch
```

### Event Logging
```jsonl
{
  "type": "recovery_action",
  "timestamp": 1707850800000,
  "taskId": "AOF-123",
  "action": "lease_expired",
  "details": { "leaseExpiredAt": 1707850200000, "transitionedTo": "ready" }
}
```

### No Retry Logic
- [ ] Recovery does NOT retry the original operation
- [ ] Recovery only checks system state (lease/heartbeat)
- [ ] If recovery doesn't resolve issue, user gets actionable error message

---

## Test Requirements

### Unit Tests (8 tests minimum)
1. `--recover-on-failure` flag is parsed correctly
2. Expired lease triggers recovery (transition to `ready`)
3. Stale heartbeat triggers artifact expiry
4. Recovery actions are logged to events.jsonl
5. Recovery summary is formatted correctly
6. Recovery does not run if flag is absent
7. Recovery stops after one check (no infinite retry)
8. Actionable error message if recovery fails to resolve issue

### Integration Tests (3 tests minimum)
1. Task with expired lease → CLI recovery → task transitions to `ready`
2. Task with stale heartbeat → CLI recovery → artifact marked expired
3. Task with no recovery issues → CLI returns error without recovery

**Test Framework:** vitest  
**Run Tests:** `cd ~/Projects/AOF && npx vitest run`

---

## Implementation Notes

### Recovery Logic
```typescript
export interface RecoveryResult {
  recovered: boolean;
  actions: Array<{ type: string; details: any }>;
  error?: string;
}

export async function attemptRecovery(taskId: string): Promise<RecoveryResult> {
  const actions: RecoveryResult['actions'] = [];
  
  // Check 1: Lease expiry
  const lease = await getLease(taskId);
  if (lease && isLeaseExpired(lease)) {
    await expireLease(taskId);
    await transitionTask(taskId, 'ready');
    actions.push({ type: 'lease_expired', details: { leaseExpiredAt: lease.expiresAt } });
  }
  
  // Check 2: Heartbeat staleness
  const heartbeat = await getLatestHeartbeat(taskId);
  if (heartbeat && isHeartbeatStale(heartbeat)) {
    await markArtifactExpired(taskId);
    actions.push({ type: 'heartbeat_stale', details: { lastHeartbeatAt: heartbeat.timestamp } });
  }
  
  // Log all recovery actions
  for (const action of actions) {
    await logEvent({ type: 'recovery_action', taskId, action });
  }
  
  return {
    recovered: actions.length > 0,
    actions,
  };
}
```

### User-Facing Output
```typescript
export function formatRecoverySummary(result: RecoveryResult): string {
  if (!result.recovered) {
    return '❌ Recovery could not resolve the issue. Manual intervention required.';
  }
  
  const lines = ['🔧 Recovery triggered:'];
  for (const action of result.actions) {
    if (action.type === 'lease_expired') {
      lines.push('   - Lease expired (10min TTL exceeded)');
      lines.push('   - Task reclaimed to ready');
    }
    if (action.type === 'heartbeat_stale') {
      lines.push('   - Heartbeat stale (>10min)');
      lines.push('   - Run artifact marked expired');
    }
  }
  lines.push('✅ Recovery complete. Retry your command.');
  
  return lines.join('\n');
}
```

### CLI Integration
```typescript
// In src/cli/commands/task-close.ts

async function closeTask(taskId: string, options: { recoverOnFailure?: boolean }) {
  try {
    await closeTaskCore(taskId);
    console.log(`✅ Task ${taskId} closed`);
  } catch (err) {
    if (options.recoverOnFailure) {
      console.error(`❌ Failed to close ${taskId}: ${err.message}`);
      const recovery = await attemptRecovery(taskId);
      console.log(formatRecoverySummary(recovery));
      if (recovery.recovered) {
        console.log(`Retry: aof task close ${taskId}`);
      } else {
        process.exit(1);
      }
    } else {
      throw err; // No recovery, fail fast
    }
  }
}
```

---

## Out of Scope

- Auto-retry (recovery checks state once, does not retry original operation)
- Recovery for non-task commands (e.g., `aof org`, `aof agent`)
- Recovery mode as default (Phase 2: make it default, opt-out with `--no-recovery`)

---

## Definition of Done

1. All acceptance criteria met
2. All unit tests pass (`npx vitest run`)
3. All integration tests pass
4. Code reviewed by architect (tag @swe-architect in commit/PR)
5. CLI help text updated (`aof task close --help` shows `--recover-on-failure`)
6. Task closed: `bd close AOF-l7y --json`

---

## Questions?

If you need clarification, leave a message in my mailbox:  
`~/Projects/AOF/mailbox/swe-architect/inbox/re-aof-l7y-question.md`

---

**START HERE:**
1. Claim task: `bd update AOF-l7y --claim --json`
2. Create `src/cli/recovery.ts` (recovery logic first)
3. Write unit tests for recovery logic
4. Modify `src/cli/commands/task-close.ts` (add flag + integration)
5. Write integration test (expired lease → recovery)
6. Update CLI help text
7. Close task: `bd close AOF-l7y --json`

**Estimated Time:** 2 days  
**TDD:** Write tests before implementation
