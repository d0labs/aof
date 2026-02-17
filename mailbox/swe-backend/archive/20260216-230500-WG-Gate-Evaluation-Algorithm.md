# Task Brief: WG Gate Evaluation Algorithm (Core Logic)

**Beads Task:** AOF-acq  
**Status:** Blocked by AOF-jax, AOF-bko  
**Estimated Effort:** Large (L) — 4 hours max  
**Assigned To:** swe-backend

---

## Objective

Implement the core gate progression algorithm as a pure function. This is the deterministic logic that decides what happens when a task completes at a gate: advance, reject, or block.

## What to Build

Create `src/dispatch/gate-evaluator.ts` with gate evaluation logic:

### 1. Evaluation input/output types

```typescript
import type { Task } from "../schemas/task.js";
import type { WorkflowConfig } from "../schemas/workflow.js";
import type { GateOutcome, GateTransition } from "../schemas/gate.js";
import { evaluateGateCondition, buildGateContext } from "./gate-conditional.js";

export interface GateEvaluationInput {
  task: Task;
  workflow: WorkflowConfig;
  outcome: GateOutcome;
  summary: string;
  blockers?: string[];
  rejectionNotes?: string;
  agent?: string;
}

export interface GateEvaluationResult {
  transition: GateTransition;
  taskUpdates: {
    gate?: { current: string; entered: string };
    routing?: { role: string; workflow: string };
    gateHistory: Array<any>;
    reviewContext?: any;
    status?: string;
  };
  skippedGates: string[];
}
```

### 2. Main evaluation function

```typescript
/**
 * Evaluate gate progression for a task completion.
 * Pure function - no I/O, deterministic output.
 * 
 * @param input - Task, workflow, outcome, and completion context
 * @returns Gate transition result with task updates
 */
export function evaluateGateTransition(
  input: GateEvaluationInput
): GateEvaluationResult {
  const { task, workflow, outcome, summary, blockers, rejectionNotes, agent } = input;
  const currentGate = task.frontmatter.gate?.current;
  const timestamp = new Date().toISOString();
  const skippedGates: string[] = [];
  
  // Find current gate in workflow
  const currentGateIndex = workflow.gates.findIndex(g => g.id === currentGate);
  if (currentGateIndex === -1) {
    throw new Error(`Current gate ${currentGate} not found in workflow`);
  }
  
  const currentGateConfig = workflow.gates[currentGateIndex];
  const entered = task.frontmatter.gate?.entered ?? timestamp;
  const duration = Math.floor((Date.now() - new Date(entered).getTime()) / 1000);
  
  // Create history entry for current gate completion
  const historyEntry = {
    gate: currentGate ?? "unknown",
    role: currentGateConfig.role,
    agent,
    entered,
    exited: timestamp,
    outcome,
    summary,
    blockers: blockers ?? [],
    rejectionNotes,
    duration,
  };
  
  // Handle outcome
  if (outcome === "complete") {
    return handleCompleteOutcome(input, currentGateIndex, historyEntry, skippedGates, timestamp);
  } else if (outcome === "needs_review") {
    return handleRejectionOutcome(input, currentGateIndex, historyEntry, timestamp);
  } else if (outcome === "blocked") {
    return handleBlockedOutcome(input, historyEntry, timestamp);
  }
  
  throw new Error(`Unknown outcome: ${outcome}`);
}
```

### 3. Handle complete outcome

```typescript
function handleCompleteOutcome(
  input: GateEvaluationInput,
  currentGateIndex: number,
  historyEntry: any,
  skippedGates: string[],
  timestamp: string
): GateEvaluationResult {
  const { task, workflow } = input;
  
  // Find next active gate (skip conditionals)
  let nextGateIndex = currentGateIndex + 1;
  const context = buildGateContext(task);
  
  while (nextGateIndex < workflow.gates.length) {
    const nextGate = workflow.gates[nextGateIndex];
    
    // Check if gate is active (conditional evaluation)
    if (nextGate.when) {
      const isActive = evaluateGateCondition(nextGate.when, context);
      if (!isActive) {
        skippedGates.push(nextGate.id);
        nextGateIndex++;
        continue;  // Skip this gate
      }
    }
    
    // Found next active gate
    return {
      transition: {
        taskId: task.frontmatter.id,
        fromGate: historyEntry.gate,
        toGate: nextGate.id,
        outcome: "complete",
        agent: historyEntry.agent,
        timestamp,
        duration: historyEntry.duration,
        skipped: skippedGates,
      },
      taskUpdates: {
        gate: { current: nextGate.id, entered: timestamp },
        routing: { role: nextGate.role, workflow: workflow.name },
        gateHistory: [...(task.frontmatter.gateHistory ?? []), historyEntry],
        reviewContext: undefined,  // Clear review context on advance
      },
      skippedGates,
    };
  }
  
  // No more gates - task is complete
  return {
    transition: {
      taskId: task.frontmatter.id,
      fromGate: historyEntry.gate,
      toGate: undefined,
      outcome: "complete",
      agent: historyEntry.agent,
      timestamp,
      duration: historyEntry.duration,
      skipped: skippedGates,
    },
    taskUpdates: {
      gateHistory: [...(task.frontmatter.gateHistory ?? []), historyEntry],
      status: "done",  // Mark task complete
    },
    skippedGates,
  };
}
```

### 4. Handle rejection outcome

```typescript
function handleRejectionOutcome(
  input: GateEvaluationInput,
  currentGateIndex: number,
  historyEntry: any,
  timestamp: string
): GateEvaluationResult {
  const { task, workflow, blockers, rejectionNotes } = input;
  
  // D4: All rejections return to first gate (origin strategy)
  const targetGate = workflow.gates[0];
  const currentGateConfig = workflow.gates[currentGateIndex];
  
  return {
    transition: {
      taskId: task.frontmatter.id,
      fromGate: historyEntry.gate,
      toGate: targetGate.id,
      outcome: "needs_review",
      agent: historyEntry.agent,
      timestamp,
      duration: historyEntry.duration,
      skipped: [],
    },
    taskUpdates: {
      gate: { current: targetGate.id, entered: timestamp },
      routing: { role: targetGate.role, workflow: workflow.name },
      gateHistory: [...(task.frontmatter.gateHistory ?? []), historyEntry],
      reviewContext: {
        fromGate: historyEntry.gate,
        fromAgent: historyEntry.agent,
        fromRole: currentGateConfig.role,
        timestamp,
        blockers: blockers ?? [],
        notes: rejectionNotes ?? "",
      },
    },
    skippedGates: [],
  };
}
```

### 5. Handle blocked outcome

```typescript
function handleBlockedOutcome(
  input: GateEvaluationInput,
  historyEntry: any,
  timestamp: string
): GateEvaluationResult {
  const { task } = input;
  
  // Stay in current gate, append to history
  return {
    transition: {
      taskId: task.frontmatter.id,
      fromGate: historyEntry.gate,
      toGate: historyEntry.gate,  // Stay in same gate
      outcome: "blocked",
      agent: historyEntry.agent,
      timestamp,
      duration: historyEntry.duration,
      skipped: [],
    },
    taskUpdates: {
      gateHistory: [...(task.frontmatter.gateHistory ?? []), historyEntry],
      status: "blocked",  // Update task status
    },
    skippedGates: [],
  };
}
```

## File Structure

```
src/dispatch/gate-evaluator.ts (new file)
  - GateEvaluationInput, GateEvaluationResult types
  - evaluateGateTransition (main function)
  - handleCompleteOutcome (advance logic)
  - handleRejectionOutcome (loop-back logic)
  - handleBlockedOutcome (hold logic)
  - Export all functions and types
```

## Acceptance Criteria

1. ✅ evaluateGateTransition is a pure function (no I/O, deterministic)
2. ✅ Complete outcome advances to next gate (skips conditionals)
3. ✅ Needs_review outcome loops back to first gate (D4 origin strategy)
4. ✅ Blocked outcome keeps task in current gate
5. ✅ gateHistory appended for all outcomes
6. ✅ reviewContext set on rejection, cleared on advance
7. ✅ Skipped gates tracked and logged
8. ✅ Duration calculated from gate.entered to exit timestamp
9. ✅ File compiles without errors (`npx tsc --noEmit`)
10. ✅ JSDoc comments explain algorithm

## Dependencies

**Blocked by:**
- AOF-jax (Core schema types)
- AOF-bko (Workflow config schema)
- AOF-xak (Conditional evaluator)

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 3.1 for gate evaluation algorithm)
- Gate conditional evaluator: `src/dispatch/gate-conditional.ts` (AOF-xak)
- Workflow schema: `src/schemas/workflow.ts` (AOF-bko)

## Testing

Manual testing during integration. Unit tests will be created in AOF-9vl (separate task).

## Out of Scope

- Task state persistence (handled in scheduler, AOF-9eq)
- Routing to agents (handled in scheduler)
- Telemetry emission (handled in scheduler, AOF-mmd)
- Race condition handling (handled in scheduler with file locks)

## Estimated Tests

~10 unit tests (will be created in AOF-9vl):
- Complete advances to next gate
- Complete skips conditional gates
- Complete at last gate marks done
- Needs_review loops to first gate
- Needs_review sets reviewContext
- Blocked stays in current gate
- Gate history appended correctly
- Duration calculated correctly
- Skipped gates tracked

---

**To claim this task:** `bd update AOF-acq --claim --json`  
**To complete:** `bd close AOF-acq --json`

**Note:** Do NOT start until AOF-jax, AOF-bko, and AOF-xak are complete and merged.
