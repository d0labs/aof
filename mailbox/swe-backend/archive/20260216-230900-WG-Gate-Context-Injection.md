# Task Brief: WG Gate Context Injection for Task Payloads

**Beads Task:** AOF-ofi  
**Status:** Blocked by AOF-bko (Workflow config schema)  
**Estimated Effort:** Medium (M) — 3 hours max  
**Assigned To:** swe-backend

---

## Objective

Add gate_context field injection when tasks are dispatched to agents. This provides progressive disclosure: agents see only what's relevant to their current gate, with clear expectations and outcome explanations.

## What to Build

Create `src/dispatch/gate-context-builder.ts` with context injection logic:

### 1. GateContext type

```typescript
import type { Gate, GateOutcome } from "../schemas/gate.js";
import type { Task } from "../schemas/task.js";

export interface GateContext {
  role: string;           // Plain-language role explanation
  gate: string;           // Current gate ID
  expectations: string[]; // Checklist for this gate
  outcomes: Record<GateOutcome, string>;  // What each outcome means
  tips?: string[];        // Optional practical guidance
}
```

### 2. Build gate context

```typescript
/**
 * Build gate context for a task at a specific gate.
 * Progressive disclosure: only show what's relevant to THIS gate.
 */
export function buildGateContext(
  task: Task,
  gate: Gate,
  workflow: WorkflowConfig
): GateContext {
  const context: GateContext = {
    role: buildRoleDescription(gate, task),
    gate: gate.id,
    expectations: buildExpectations(gate, task),
    outcomes: buildOutcomeDescriptions(gate, workflow),
    tips: buildTips(gate, task),
  };
  
  return context;
}
```

### 3. Role descriptions

```typescript
function buildRoleDescription(gate: Gate, task: Task): string {
  // Check if this is a rejection loop-back
  const reviewContext = task.frontmatter.reviewContext;
  if (reviewContext && reviewContext.fromGate !== gate.id) {
    return `You are fixing issues from a previous review.`;
  }
  
  // Standard role descriptions by gate type
  if (gate.canReject) {
    return `You are reviewing this ${getWorkType(task)} for quality and compliance.`;
  }
  
  if (gate.requireHuman) {
    return `You are providing final approval for this ${getWorkType(task)}.`;
  }
  
  return `You are ${gate.description ?? `working on the ${gate.id} stage`}.`;
}

function getWorkType(task: Task): string {
  const tags = task.frontmatter.routing.tags ?? [];
  if (tags.includes("feature")) return "feature";
  if (tags.includes("bug")) return "bug fix";
  if (tags.includes("docs")) return "documentation";
  return "work";
}
```

### 4. Expectations checklists

```typescript
function buildExpectations(gate: Gate, task: Task): string[] {
  const expectations: string[] = [];
  const reviewContext = task.frontmatter.reviewContext;
  
  // If looped back from review, expectations focus on fixes
  if (reviewContext) {
    expectations.push("Address ALL blockers listed in reviewContext below");
    expectations.push("Don't introduce new issues while fixing");
    expectations.push("Re-run tests and coverage checks");
    return expectations;
  }
  
  // Standard expectations by gate characteristics
  if (gate.canReject) {
    // Review gate
    expectations.push("Review for quality and correctness");
    expectations.push("Check for security issues");
    expectations.push("Verify all requirements are met");
    if (gate.description) {
      expectations.push(gate.description);
    }
  } else if (gate.requireHuman) {
    // Approval gate
    expectations.push("Verify deliverables meet acceptance criteria");
    expectations.push("Confirm no blocking issues remain");
  } else {
    // Implementation gate
    expectations.push("Complete the work described in the task");
    if (gate.description) {
      expectations.push(gate.description);
    }
  }
  
  return expectations;
}
```

### 5. Outcome descriptions

```typescript
function buildOutcomeDescriptions(gate: Gate, workflow: WorkflowConfig): Record<GateOutcome, string> {
  const outcomes: Record<GateOutcome, string> = {
    complete: "Work is done and ready to advance to the next stage",
    needs_review: "Work needs revision - list specific issues to fix",
    blocked: "Cannot proceed - external dependency or blocker",
  };
  
  // Customize based on gate position
  const gateIndex = workflow.gates.findIndex(g => g.id === gate.id);
  const isLastGate = gateIndex === workflow.gates.length - 1;
  
  if (isLastGate) {
    outcomes.complete = "Work is complete - task will be marked done";
  } else if (gateIndex >= 0 && gateIndex < workflow.gates.length - 1) {
    const nextGate = workflow.gates[gateIndex + 1];
    outcomes.complete = `Work is done - it will advance to ${nextGate.id}`;
  }
  
  if (gate.canReject) {
    outcomes.needs_review = "Work needs fixes - it will go back to the implementer";
  } else {
    outcomes.needs_review = "Not applicable for this gate";
  }
  
  return outcomes;
}
```

### 6. Tips

```typescript
function buildTips(gate: Gate, task: Task): string[] | undefined {
  const tips: string[] = [];
  
  if (gate.canReject) {
    tips.push("Be specific in blockers - vague feedback wastes time");
    tips.push("One blocker per issue for clarity");
  }
  
  const reviewContext = task.frontmatter.reviewContext;
  if (reviewContext && reviewContext.blockers.length > 0) {
    tips.push(`Review feedback: ${reviewContext.blockers.length} issues to address`);
  }
  
  return tips.length > 0 ? tips : undefined;
}
```

### 7. Integrate with scheduler dispatch

Modify `src/dispatch/scheduler.ts` to inject gate_context when assigning tasks:

```typescript
async assignTask(task: Task): Promise<void> {
  // ... existing assignment logic ...
  
  // If task is in a gate workflow, inject gate context
  if (task.frontmatter.gate) {
    const projectManifest = await this.loadProjectManifest(task.frontmatter.project);
    if (projectManifest.workflow) {
      const currentGate = projectManifest.workflow.gates.find(
        g => g.id === task.frontmatter.gate?.current
      );
      
      if (currentGate) {
        const gateContext = buildGateContext(task, currentGate, projectManifest.workflow);
        
        // Add to task payload (transient, not persisted)
        (task as any).gate_context = gateContext;
      }
    }
  }
  
  // ... rest of assignment ...
}
```

## File Structure

```
src/dispatch/gate-context-builder.ts (new file)
  - GateContext type
  - buildGateContext function
  - Helper functions for role, expectations, outcomes, tips
  - Export all functions and types

src/dispatch/scheduler.ts (modify)
  - Import buildGateContext
  - Inject gate_context during task assignment
```

## Acceptance Criteria

1. ✅ GateContext type defined
2. ✅ buildGateContext generates context based on gate characteristics
3. ✅ Role descriptions adapt to gate type (review, approval, implementation)
4. ✅ Expectations checklist adapts to gate and review context
5. ✅ Outcome descriptions explain what each outcome does
6. ✅ Tips provided when helpful (not always)
7. ✅ gate_context injected into task payload during dispatch
8. ✅ File compiles without errors (`npx tsc --noEmit`)

## Dependencies

**Blocked by:**
- AOF-bko (Workflow config schema)

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 4.2 for gate context examples)
- Workflow schema: `src/schemas/workflow.ts`
- Scheduler: `src/dispatch/scheduler.ts`

## Testing

Manual testing during integration. Integration tests in AOF-27d will verify gate_context is present.

## Out of Scope

- Persisting gate_context to task file (it's transient, computed on dispatch)
- Localization/internationalization (v1 is English only)
- Customizable templates (v1 uses hardcoded logic)

## Estimated Tests

0 (manual testing, integration tests in AOF-27d)

---

**To claim this task:** `bd update AOF-ofi --claim --json`  
**To complete:** `bd close AOF-ofi --json`

**Note:** Do NOT start until AOF-bko is complete and merged.
