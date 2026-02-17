# Task Brief: WG Gate Timeout Detection + Auto-Escalation

**Beads Task:** AOF-69l  
**Status:** Blocked by AOF-9eq (Scheduler gate handler)  
**Estimated Effort:** Medium (M) — 3 hours max  
**Assigned To:** swe-backend

---

## Objective

Add timeout detection to the scheduler's poll loop. Detect tasks that have exceeded their gate timeout and automatically escalate to the configured escalation role.

## What to Build

Modify `src/dispatch/scheduler.ts` to add timeout checking:

### 1. Add timeout checker to poll loop

```typescript
/**
 * Check for tasks exceeding gate timeouts and escalate.
 * Called during each scheduler poll.
 */
async checkGateTimeouts(): Promise<SchedulerAction[]> {
  const actions: SchedulerAction[] = [];
  const now = Date.now();
  
  // Scan all in-progress tasks
  const tasks = await this.store.list({ status: "in-progress" });
  
  for (const task of tasks) {
    // Skip tasks not in gate workflow
    if (!task.frontmatter.gate) continue;
    
    // Load project workflow
    const projectManifest = await this.loadProjectManifest(task.frontmatter.project);
    if (!projectManifest.workflow) continue;
    
    const workflow = projectManifest.workflow;
    const currentGate = workflow.gates.find(g => g.id === task.frontmatter.gate?.current);
    if (!currentGate) continue;
    
    // Check if gate has timeout configured
    if (!currentGate.timeout) continue;
    
    // Parse timeout duration
    const timeoutMs = parseDuration(currentGate.timeout);
    if (!timeoutMs) {
      this.logger.warn("Invalid timeout format", {
        gate: currentGate.id,
        timeout: currentGate.timeout,
      });
      continue;
    }
    
    // Check if task has exceeded timeout
    const entered = new Date(task.frontmatter.gate.entered).getTime();
    const elapsed = now - entered;
    
    if (elapsed > timeoutMs) {
      // Timeout exceeded - escalate
      const action = await this.escalateGateTimeout(task, currentGate, workflow, elapsed);
      actions.push(action);
    }
  }
  
  return actions;
}
```

### 2. Escalate on timeout

```typescript
/**
 * Escalate a task that has exceeded gate timeout.
 */
private async escalateGateTimeout(
  task: Task,
  gate: Gate,
  workflow: WorkflowConfig,
  elapsedMs: number
): Promise<SchedulerAction> {
  const escalateToRole = gate.escalateTo;
  
  if (!escalateToRole) {
    // No escalation target - just log and emit metric
    this.logger.log("gate_timeout_no_escalation", {
      taskId: task.frontmatter.id,
      gate: gate.id,
      elapsed: elapsedMs,
    });
    
    return {
      type: "alert",
      taskId: task.frontmatter.id,
      taskTitle: task.frontmatter.title,
      reason: `Gate ${gate.id} timeout (${elapsedMs}ms), no escalation configured`,
    };
  }
  
  // Update task routing to escalation role
  task.frontmatter.routing.role = escalateToRole;
  task.frontmatter.updatedAt = new Date().toISOString();
  
  // Add note to gate history
  const historyEntry = {
    gate: gate.id,
    role: gate.role,
    entered: task.frontmatter.gate!.entered,
    exited: new Date().toISOString(),
    outcome: "blocked" as const,
    summary: `Timeout exceeded (${Math.floor(elapsedMs / 1000)}s), escalated to ${escalateToRole}`,
    blockers: [`Timeout: no response from ${gate.role} within ${gate.timeout}`],
    duration: Math.floor(elapsedMs / 1000),
  };
  
  task.frontmatter.gateHistory = [
    ...(task.frontmatter.gateHistory ?? []),
    historyEntry,
  ];
  
  // Update task
  await this.store.update(task.frontmatter.id, {
    frontmatter: task.frontmatter,
    body: task.body,
  });
  
  // Log event
  this.logger.log("gate_timeout_escalation", {
    taskId: task.frontmatter.id,
    gate: gate.id,
    fromRole: gate.role,
    toRole: escalateToRole,
    elapsed: elapsedMs,
  });
  
  return {
    type: "alert",
    taskId: task.frontmatter.id,
    taskTitle: task.frontmatter.title,
    agent: escalateToRole,
    reason: `Gate ${gate.id} timeout, escalated from ${gate.role} to ${escalateToRole}`,
  };
}
```

### 3. Duration parser

```typescript
/**
 * Parse duration string (e.g., "1h", "30m", "2h") to milliseconds.
 * @returns milliseconds or null if invalid format
 */
function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+)([mh])$/);
  if (!match) return null;
  
  const value = parseInt(match[1], 10);
  const unit = match[2];
  
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  
  return null;
}
```

### 4. Integrate into poll loop

Modify the `poll` method to call `checkGateTimeouts`:

```typescript
async poll(): Promise<PollResult> {
  // ... existing poll logic ...
  
  // Check gate timeouts
  const timeoutActions = await this.checkGateTimeouts();
  actions.push(...timeoutActions);
  
  // ... rest of poll logic ...
}
```

## File Structure

```
src/dispatch/scheduler.ts (modify)
  - Add checkGateTimeouts method
  - Add escalateGateTimeout private method
  - Add parseDuration helper function
  - Integrate into poll loop
```

## Acceptance Criteria

1. ✅ checkGateTimeouts scans in-progress tasks for gate timeouts
2. ✅ Timeouts trigger escalation to escalateTo role
3. ✅ History entry appended with timeout details
4. ✅ Event logged for observability
5. ✅ parseDuration handles "1h", "30m", "2h" formats
6. ✅ Invalid duration formats logged as warnings
7. ✅ File compiles without errors (`npx tsc --noEmit`)
8. ✅ Backward compatible (non-gate tasks unaffected)

## Dependencies

**Blocked by:**
- AOF-9eq (Scheduler gate transition handler)

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section D2 for timeout values)
- Scheduler: `src/dispatch/scheduler.ts` (modified in AOF-9eq)
- Gate schema: `src/schemas/gate.ts`

## Testing

Manual testing during integration. Integration tests in AOF-27d will cover timeout scenarios.

## Out of Scope

- Smarter escalation strategies (v1 is simple role reassignment)
- Timeout history tracking (gate history already captures it)
- Configurable timeout behavior (v1 only supports escalation)

## Timeout Values (from D2)

- Review gates (code-review, QA, security, docs, approve): **1 hour**
- Implement gate: **2 hours**

These are the default values projects should use.

## Estimated Tests

~3 integration tests (in AOF-27d):
- Task exceeding timeout escalates to configured role
- Task without escalateTo logs warning
- Duration parsing for various formats

---

**To claim this task:** `bd update AOF-69l --claim --json`  
**To complete:** `bd close AOF-69l --json`

**Note:** Do NOT start until AOF-9eq is complete and merged.
