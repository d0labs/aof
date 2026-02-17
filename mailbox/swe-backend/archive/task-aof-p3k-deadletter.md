# Task Brief: Deadletter Status + Resurrection Command

**Beads Task ID:** AOF-p3k  
**Priority:** Phase 1.5 Recovery Hardening  
**Assigned To:** swe-backend  
**Estimate:** 2 person-days  
**Dependencies:** None (ready to start)

---

## Objective

Add `deadletter` status to task state machine. After 3 dispatch failures, transition `ready → deadletter`. Move task file to `tasks/deadletter/`. Implement `aof task resurrect <id>` command to transition `deadletter → ready`.

**Claim this task:** `bd update AOF-p3k --claim --json`  
**View details:** `bd show AOF-p3k --json`

---

## Context

PO approved Phase 1.5 Recovery Hardening (see `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md` §3). Tasks that fail dispatch 3 times should be removed from active queue and require manual investigation before retrying.

**Requirements Section:** §3 + §5.3 in recovery-requirements.md

---

## Scope

### Files to Create
1. **src/status/deadletter.ts** — Deadletter transition logic
2. **src/cli/commands/task-resurrect.ts** — Resurrection command
3. **tasks/deadletter/** — Directory for deadletter tasks (create on first use)

### Files to Modify
1. **src/types/task.ts** — Add `deadletter` to TaskStatus enum
2. **src/scheduler/dispatcher.ts** — Track dispatch failures, transition after 3 failures
3. **src/events.ts** — Add `deadletter_transition` event type
4. **src/cli/commands/index.ts** — Register `task resurrect` command

---

## Acceptance Criteria

### State Machine
- [ ] TaskStatus enum includes `deadletter`
- [ ] Valid transitions: `ready → deadletter`, `deadletter → ready` (via resurrection)
- [ ] After 3 dispatch failures, task transitions to `deadletter`
- [ ] Dispatch failure count tracked in task metadata (e.g., `dispatchFailures: number`)

### File Management
- [ ] Deadletter tasks moved to `tasks/deadletter/<task-id>.md`
- [ ] Task status in frontmatter updated to `deadletter`
- [ ] Original task file in `tasks/open/` or `tasks/ready/` is deleted

### Resurrection Command
- [ ] `aof task resurrect <task-id>` transitions `deadletter → ready`
- [ ] Task file moved from `tasks/deadletter/` back to `tasks/ready/`
- [ ] Dispatch failure count reset to 0
- [ ] Resurrection logged to events.jsonl

### Event Logging
```jsonl
{
  "type": "deadletter_transition",
  "timestamp": 1707850800000,
  "taskId": "AOF-123",
  "reason": "max_dispatch_failures",
  "failureCount": 3,
  "lastFailureReason": "agent not available"
}
```

```jsonl
{
  "type": "task_resurrected",
  "timestamp": 1707851000000,
  "taskId": "AOF-123",
  "resurrectedBy": "xavier"
}
```

### CLI Output
```bash
$ aof task resurrect AOF-123
✅ Task AOF-123 resurrected (deadletter → ready)
   Ready for re-dispatch on next scheduler poll.

$ aof task resurrect AOF-999
❌ Task AOF-999 not found in deadletter queue
```

---

## Test Requirements

### Unit Tests (8 tests minimum)
1. TaskStatus enum includes `deadletter`
2. Transition `ready → deadletter` is valid
3. Transition `deadletter → ready` is valid
4. Dispatch failure count increments on each failure
5. After 3 failures, task transitions to `deadletter`
6. Deadletter transition moves task file to `tasks/deadletter/`
7. Resurrection moves task file back to `tasks/ready/`
8. Resurrection resets dispatch failure count to 0

### Integration Tests (3 tests minimum)
1. Dispatch task 3 times (all fail) → verify task in `tasks/deadletter/`
2. Resurrect task → verify task in `tasks/ready/`, status is `ready`
3. Resurrect non-existent task → verify error message

**Test Framework:** vitest  
**Run Tests:** `cd ~/Projects/AOF && npx vitest run`

---

## Implementation Notes

### Dispatch Failure Tracking
```typescript
// In src/scheduler/dispatcher.ts

interface TaskMetadata {
  dispatchFailures?: number;
  lastDispatchFailureReason?: string;
  lastDispatchFailureAt?: number;
}

async function dispatchTask(task: Task): Promise<void> {
  try {
    await dispatchToAgent(task);
    // Reset failure count on success
    await updateTaskMetadata(task.id, { dispatchFailures: 0 });
  } catch (err) {
    const failures = (task.metadata?.dispatchFailures ?? 0) + 1;
    await updateTaskMetadata(task.id, {
      dispatchFailures: failures,
      lastDispatchFailureReason: err.message,
      lastDispatchFailureAt: Date.now(),
    });
    
    if (failures >= 3) {
      await transitionToDeadletter(task.id, err.message);
    }
  }
}
```

### Deadletter Transition
```typescript
export async function transitionToDeadletter(taskId: string, reason: string): Promise<void> {
  const task = await loadTask(taskId);
  
  // Update status
  task.status = 'deadletter';
  
  // Move file
  const oldPath = path.join('tasks', task.status, `${taskId}.md`);
  const newPath = path.join('tasks', 'deadletter', `${taskId}.md`);
  await fs.mkdir(path.dirname(newPath), { recursive: true });
  await fs.rename(oldPath, newPath);
  
  // Log event
  await logEvent({
    type: 'deadletter_transition',
    taskId,
    reason: 'max_dispatch_failures',
    failureCount: task.metadata.dispatchFailures,
    lastFailureReason: reason,
  });
}
```

### Resurrection Command
```typescript
export async function resurrectTask(taskId: string, userName: string): Promise<void> {
  // Load task from deadletter
  const deadletterPath = path.join('tasks', 'deadletter', `${taskId}.md`);
  if (!fs.existsSync(deadletterPath)) {
    throw new Error(`Task ${taskId} not found in deadletter queue`);
  }
  
  const task = await loadTask(taskId);
  
  // Reset state
  task.status = 'ready';
  task.metadata.dispatchFailures = 0;
  delete task.metadata.lastDispatchFailureReason;
  delete task.metadata.lastDispatchFailureAt;
  
  // Move file back
  const newPath = path.join('tasks', 'ready', `${taskId}.md`);
  await fs.rename(deadletterPath, newPath);
  
  // Log event
  await logEvent({
    type: 'task_resurrected',
    taskId,
    resurrectedBy: userName,
  });
  
  console.log(`✅ Task ${taskId} resurrected (deadletter → ready)`);
}
```

---

## Out of Scope

- Auto-resurrection after timeout (deadletter requires manual intervention)
- Deadletter dashboard UI (Phase 2)
- Batch resurrection command (`aof task resurrect-all`)
- Deadletter task expiry (auto-close after 30 days)

---

## Definition of Done

1. All acceptance criteria met
2. All unit tests pass (`npx vitest run`)
3. All integration tests pass
4. Code reviewed by architect (tag @swe-architect in commit/PR)
5. CLI help text updated (`aof task resurrect --help`)
6. Task closed: `bd close AOF-p3k --json`

---

## Questions?

If you need clarification, leave a message in my mailbox:  
`~/Projects/AOF/mailbox/swe-architect/inbox/re-aof-p3k-question.md`

---

**START HERE:**
1. Claim task: `bd update AOF-p3k --claim --json`
2. Modify `src/types/task.ts` (add `deadletter` to TaskStatus)
3. Create `src/status/deadletter.ts` (transition logic)
4. Modify `src/scheduler/dispatcher.ts` (track failures, trigger transition)
5. Create `src/cli/commands/task-resurrect.ts` (resurrection command)
6. Write unit tests
7. Write integration test (3 failures → deadletter)
8. Close task: `bd close AOF-p3k --json`

**Estimated Time:** 2 days  
**TDD:** Write tests before implementation
