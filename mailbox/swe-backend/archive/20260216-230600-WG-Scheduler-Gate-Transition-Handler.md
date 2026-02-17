# Task Brief: WG Scheduler Gate Transition Handler

**Beads Task:** AOF-9eq  
**Status:** Blocked by AOF-60p, AOF-bko, AOF-acq, AOF-xak  
**Estimated Effort:** Large (L) — 4 hours max  
**Assigned To:** swe-backend

---

## Objective

Integrate gate evaluation into the scheduler. Add `handleGateTransition` method that orchestrates gate progression: evaluate outcome, update task state atomically, route to next role, emit events.

## What to Build

Modify `src/dispatch/scheduler.ts` to add gate-aware completion handling:

### 1. Import gate modules

```typescript
import { evaluateGateTransition, type GateEvaluationInput } from "./gate-evaluator.js";
import { validateWorkflow } from "../schemas/workflow.js";
import { validateWorkflowRoles } from "../schemas/org-chart.js";
import type { GateOutcome } from "../schemas/gate.js";
```

### 2. Add handleGateTransition method to scheduler

```typescript
/**
 * Handle task completion at a gate.
 * Evaluates next gate, updates task state, routes to next role.
 * 
 * @param taskId - Task ID completing the gate
 * @param outcome - Gate outcome (complete | needs_review | blocked)
 * @param context - Completion context (summary, blockers, etc.)
 * @returns Gate transition result
 */
async handleGateTransition(
  taskId: string,
  outcome: GateOutcome,
  context: {
    summary: string;
    blockers?: string[];
    rejectionNotes?: string;
    agent?: string;
  }
): Promise<GateTransition> {
  const store = this.store;  // TaskStore instance
  
  // Load task
  const task = await store.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  
  // Load project to get workflow config
  const projectManifest = await this.loadProjectManifest(task.frontmatter.project);
  if (!projectManifest.workflow) {
    throw new Error(`Project ${task.frontmatter.project} has no workflow configured`);
  }
  
  const workflow = projectManifest.workflow;
  
  // Validate workflow (defensive check)
  const workflowErrors = validateWorkflow(workflow);
  if (workflowErrors.length > 0) {
    throw new Error(`Invalid workflow: ${workflowErrors.join(", ")}`);
  }
  
  // Check if task is in a gate (backward compatibility)
  if (!task.frontmatter.gate) {
    throw new Error(`Task ${taskId} is not in a gate workflow`);
  }
  
  // Evaluate gate transition
  const input: GateEvaluationInput = {
    task,
    workflow,
    outcome,
    summary: context.summary,
    blockers: context.blockers,
    rejectionNotes: context.rejectionNotes,
    agent: context.agent,
  };
  
  const result = evaluateGateTransition(input);
  
  // Update task state atomically
  await this.applyGateTransition(task, result);
  
  // Log event
  this.logger.log("gate_transition", {
    taskId: task.frontmatter.id,
    fromGate: result.transition.fromGate,
    toGate: result.transition.toGate,
    outcome,
    agent: context.agent,
    duration: result.transition.duration,
    skipped: result.skippedGates,
  });
  
  return result.transition;
}
```

### 3. Apply gate transition to task

```typescript
/**
 * Apply gate transition updates to task (atomic write).
 */
private async applyGateTransition(
  task: Task,
  result: GateEvaluationResult
): Promise<void> {
  const updates = result.taskUpdates;
  
  // Apply updates to task frontmatter
  if (updates.gate) {
    task.frontmatter.gate = updates.gate;
  }
  if (updates.routing) {
    task.frontmatter.routing = {
      ...task.frontmatter.routing,
      ...updates.routing,
    };
  }
  if (updates.gateHistory) {
    task.frontmatter.gateHistory = updates.gateHistory;
  }
  if (updates.reviewContext !== undefined) {
    task.frontmatter.reviewContext = updates.reviewContext;
  }
  if (updates.status) {
    task.frontmatter.status = updates.status as TaskStatus;
  }
  
  // Update timestamp
  task.frontmatter.updatedAt = new Date().toISOString();
  
  // Write task atomically
  await this.store.update(task.frontmatter.id, {
    frontmatter: task.frontmatter,
    body: task.body,
  });
}
```

### 4. Helper to load project manifest

```typescript
/**
 * Load project manifest from project.yaml.
 */
private async loadProjectManifest(projectId: string): Promise<ProjectManifest> {
  const projectPath = join(this.config.dataDir, "Projects", projectId, "project.yaml");
  
  // Read and parse YAML (add proper error handling)
  const yaml = await fs.promises.readFile(projectPath, "utf-8");
  const parsed = YAML.parse(yaml);
  
  // Validate with Zod schema
  return ProjectManifest.parse(parsed);
}
```

### 5. Modify aofTaskComplete to use handleGateTransition

Modify `src/tools/aof-tools.ts` to call scheduler's handleGateTransition when outcome is provided:

```typescript
export async function aofTaskComplete(
  ctx: ToolContext,
  input: AOFTaskCompleteInput
): Promise<AOFTaskCompleteResult> {
  // ... existing validation ...
  
  // If outcome provided, use gate transition handler
  if (input.outcome) {
    const scheduler = ctx.scheduler;  // Scheduler instance (add to ToolContext)
    
    await scheduler.handleGateTransition(
      input.taskId,
      input.outcome,
      {
        summary: input.summary ?? "Completed",
        blockers: input.blockers,
        rejectionNotes: input.rejectionNotes,
        agent: input.actor,
      }
    );
    
    // Return success
    return {
      taskId: input.taskId,
      status: "in-progress",  // Status updated by transition
      ...compactResponse(),
    };
  }
  
  // ... existing completion logic (backward compatible) ...
}
```

## File Structure

```
src/dispatch/scheduler.ts (modify)
  - Add handleGateTransition method
  - Add applyGateTransition private method
  - Add loadProjectManifest helper
  - Import gate evaluator and workflow validation

src/tools/aof-tools.ts (modify)
  - Extend AOFTaskCompleteInput with outcome, blockers, rejectionNotes
  - Call scheduler.handleGateTransition when outcome provided
  - Maintain backward compatibility (outcome optional)
```

## Acceptance Criteria

1. ✅ handleGateTransition method implemented in scheduler
2. ✅ Task state updates applied atomically (single write)
3. ✅ Gate transitions logged to event stream
4. ✅ aofTaskComplete calls handleGateTransition when outcome provided
5. ✅ Backward compatible (tasks without workflows still work)
6. ✅ File compiles without errors (`npx tsc --noEmit`)
7. ✅ Existing scheduler tests pass (if any)

## Dependencies

**Blocked by:**
- AOF-60p (Task schema extension)
- AOF-bko (Workflow config schema)
- AOF-acq (Gate evaluation algorithm)
- AOF-xak (Conditional evaluator)

## References

- Design doc: `~/Projects/AOF/docs/design/WORKFLOW-GATES-DESIGN.md` (Section 6.1 for scheduler integration)
- Gate evaluator: `src/dispatch/gate-evaluator.ts` (AOF-acq)
- Scheduler: `src/dispatch/scheduler.ts` (existing)
- AOF tools: `src/tools/aof-tools.ts` (existing)

## Testing

Manual testing during integration. Integration tests will be created in AOF-27d (separate task).

## Out of Scope

- Timeout detection (separate task: AOF-69l)
- Telemetry emission (separate task: AOF-mmd)
- Race condition handling (use existing lease mechanism)
- Gate context injection (separate task: AOF-ofi)

## Estimated Tests

0 (integration tests in AOF-27d)

---

**To claim this task:** `bd update AOF-9eq --claim --json`  
**To complete:** `bd close AOF-9eq --json`

**Note:** Do NOT start until AOF-60p, AOF-bko, AOF-acq, and AOF-xak are complete and merged.
