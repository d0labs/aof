# Vision Brief: Workflow Gates Primitive

**From:** Product Owner  
**To:** Architect  
**Date:** 2026-02-16  
**Priority:** HIGHEST — Xav directive, blocking Project Xray success  
**Type:** Vision → Architecture handoff  

---

## The Problem (Project Xray Findings)

Project Xray on Mule revealed a critical gap: **agents complete work and mark tasks "done" without any enforcement of process gates.**

**What we expected:**
- Implement → Code Review → QA → Security → PO Sign-off
- Rejections loop back with feedback
- No task ships without passing all gates

**What actually happened:**
- Agents did their work and called it done
- No code review, no QA validation, no security audit, no PO approval
- The SDLC defined in roadmap was aspirational, not enforced

**Root cause:** AOF has no mechanism to codify and enforce multi-step workflows with review gates and feedback loops.

This is not a "process compliance" problem — it's a **missing primitive**. We need workflow gates to be first-class, deterministic, and observable.

---

## The Vision: Workflow Gates Primitive

A **generic, domain-neutral workflow primitive** that codifies multi-step processes with:

1. **Sequential gates** — work progresses through defined stages
2. **Role-based routing** — each gate maps to a role (which maps to agents via org chart)
3. **Rejection loops** — reviewers can bounce work back to previous gates with context
4. **Conditional gates** — skip gates based on task metadata (tags, properties, etc.)
5. **Project-level config** — workflow is defined once per project, not per task
6. **Agent-transparent execution** — agents don't need to understand the workflow

### Core User Experience

**For agents (the critical constraint):**
- Get assigned a task with full context
- Do the work
- Call `aof_task_complete(outcome, summary)`
- That's it. No workflow knowledge needed.

**For humans configuring workflows:**
- Define gates in `project.yaml`
- Map gates to roles (org chart handles agent assignment)
- Mark gates as reviewable (can reject) or pass-through
- Add conditional logic for optional gates

**For AOF (invisible to users):**
- Knows current gate for each task
- Routes completed work to next gate automatically
- Handles rejection loops (bounces task back with feedback appended)
- Logs every transition for observability
- Enforces gate progression deterministically

---

## Key Constraints

### 1. Domain-Neutral Design
**Do NOT call this "SDLC" or couple it to software concepts.**

This primitive must work for:
- Software development (implement → review → test → ship)
- Sales pipelines (lead → qualify → demo → close)
- Content workflows (draft → edit → review → publish)
- Compliance processes (submit → audit → approve → archive)

Use generic terminology: **gates**, **stages**, **pipeline**, **workflow**, **progression**.

### 2. Agent Simplicity
This must work for even simple agents (qwen3-coder:30b on Mule).

**Agent contract:**
```
1. Receive task with context
2. Do work
3. Call aof_task_complete(outcome, summary)
```

No protocol knowledge. No workflow awareness. No manual routing.

### 3. Deterministic Control Plane
Gate progression logic is **pure TypeScript** — no LLM calls in the scheduler.

- Which gate is next? → Deterministic lookup
- Does this task need security review? → Boolean eval of task metadata
- Should this rejection loop back? → Gate config + outcome parsing

### 4. Filesystem-Native State
Workflow state is derived from task files, not stored separately.

Task frontmatter should include:
- Current gate ID
- Gate history (who reviewed when, outcomes, rejections)
- Rejection context (if bounced back)

Mailbox and status views are computed from canonical task files.

### 5. Observable by Default
Every gate transition must:
- Emit telemetry (Prometheus counters/histograms)
- Log to event stream (JSONL)
- Update task history atomically

We need to answer:
- How long do tasks spend in each gate?
- What's the rejection rate per gate?
- Which gates are bottlenecks?

---

## Demerzel's Design (Starting Point)

Demerzel sketched this design — use as starting point, not gospel:

### 1. Project-Level Workflow Definition

```yaml
# project.yaml
workflow:
  gates:
    - id: implement
      role: backend           # maps to agent via org chart
      
    - id: code-review
      role: architect
      canReject: true         # can send back to previous gate
      
    - id: test
      role: qa
      canReject: true
      
    - id: security
      role: security
      when: tags.includes("security")   # conditional gate
      
    - id: docs
      role: tech-writer
      when: tags.includes("docs")
      
    - id: accept
      role: po
```

### 2. Agent Experience

```typescript
// Agent receives task with full context
const task = await aof.getMyTask();

// Agent does work (semantic workload)
await doTheWork(task);

// Agent signals completion (deterministic routing takes over)
await aof.taskComplete({
  outcome: "complete",  // or "needs_review"
  summary: "Implemented feature X with tests"
});

// AOF handles routing to next gate automatically
```

### 3. Rejection Flow

```typescript
// Reviewer evaluates work
await aof.taskComplete({
  outcome: "needs_review",
  blockers: [
    "Missing error handling in API endpoint",
    "Test coverage below 80%"
  ]
});

// AOF automatically:
// 1. Moves task back to previous gate
// 2. Appends rejection context to task
// 3. Assigns back to original agent (or next available with same role)
// 4. Logs transition for observability
```

### 4. Conditional Gates

Skip gates based on task metadata:

```yaml
- id: security
  role: security
  when: tags.includes("security")
  
- id: docs
  role: tech-writer
  when: tags.includes("docs") || changes.includes("API")
```

### 5. Swappable Per Project

**Quick prototype:**
```yaml
workflow:
  gates:
    - id: implement
      role: backend
    - id: accept
      role: po
```

**Production:**
```yaml
workflow:
  gates:
    - id: implement
      role: backend
    - id: code-review
      role: architect
      canReject: true
    - id: test
      role: qa
      canReject: true
    - id: security
      role: security
      canReject: true
    - id: accept
      role: po
```

Agents don't care — same tools, same interface.

---

## Product Owner Recommendations

### Naming: "Workflow Gates" or "Process Pipeline"

**Prefer:** "Workflow Gates" or just "Gates"

**Rationale:**
- "Gates" is domain-neutral (quality gates, approval gates, stage gates)
- "Pipeline" works but has CI/CD connotations
- "Workflow" is clear but generic

**Suggested terminology:**
- **Gate** — a stage in the workflow (e.g., "code-review", "test")
- **Progression** — moving forward through gates
- **Rejection** or **Loop-back** — returning to a previous gate
- **Outcome** — agent's completion signal (complete, needs_review, blocked, etc.)

### Abstraction Level: Primitive, Not Framework

This should be a **composable primitive**, not a heavyweight workflow engine.

**What it is:**
- A state machine for task progression
- Role-based routing with conditional logic
- Rejection loop handling
- Observability hooks

**What it is NOT:**
- BPMN/drag-and-drop designer
- Parallel workflow execution (that's dependency DAG, already exists)
- SLA enforcement (observability enables this externally)
- User-facing UI (dashboards are Grafana's job)

### How This Fits AOF's Core Vision

From `vision.md`:
> "AOF bridges deterministic and semantic workloads — giving LLM agents the structure to behave reliably without losing what makes them useful."

**Workflow gates are the perfect embodiment of this thesis:**

| Aspect | Deterministic | Semantic |
|--------|---------------|----------|
| **What** | Gate progression logic | Agent work at each gate |
| **Who decides** | Config + task metadata | Agent reasoning |
| **Routing** | TypeScript state machine | N/A |
| **Execution** | Scheduler dispatches by role | Agent does the work |
| **Observability** | Every transition logged | Telemetry on outcomes |

**Key insight:** The workflow *execution* is deterministic (no LLM in scheduler), but the *work being routed* is semantic (agent reasoning). This is exactly what AOF is designed to do.

### Critical Success Factors

1. **Agent simplicity** — if agents need workflow knowledge, we've failed
2. **Config simplicity** — if humans can't define a workflow in <20 lines YAML, we've failed
3. **Observability** — if we can't measure gate bottlenecks, we've failed
4. **Rejection UX** — if feedback doesn't flow back cleanly, we've failed

### Integration Points (for architect to consider)

- **Task files** — frontmatter needs `currentGate`, `gateHistory`
- **Scheduler** — needs gate-aware dispatch (role + gate context)
- **Protocols** — `aof_task_complete` needs outcome parsing and gate transition logic
- **Org chart** — maps gate roles to agents
- **Telemetry** — new metrics for gate transitions, rejections, durations
- **Projects** — workflow definition lives in `project.yaml`

---

## Your Task (Architect)

**Produce a high-level design document** that covers:

1. **Data model**
   - Task frontmatter changes (gate state, history)
   - Workflow config schema (YAML structure)
   - Outcome types and rejection payloads

2. **Control flow**
   - How scheduler evaluates next gate
   - Conditional gate logic (when expressions)
   - Rejection loop-back algorithm
   - Edge cases (what if role has no agents? what if gate config changes mid-flight?)

3. **Integration points**
   - Scheduler changes (gate-aware dispatch)
   - Protocol changes (`aof_task_complete` outcome handling)
   - Telemetry additions (new metrics/events)
   - Config validation (workflow definition errors)

4. **Observability**
   - What metrics do we emit?
   - What's in the event log?
   - How do we debug stuck tasks or bottlenecks?

5. **Migration path**
   - How do existing tasks transition to gate-aware model?
   - How do projects opt in to workflows?
   - Backward compatibility strategy

6. **Open questions**
   - What needs PO or PM input?
   - What needs prototyping to validate?
   - What are the known unknowns?

**DO NOT write implementation code yet.** This is architecture first.

**Deliver design doc to:** `~/Projects/AOF/docs/WORKFLOW-GATES-DESIGN.md`

**Tag PO and PM for review once design is ready.**

---

## Success Looks Like

**Short term (Project Xray):**
- Agents on Mule automatically route through code-review → QA → security gates
- Rejections loop back with feedback visible to agent
- PO can see gate progression in real-time
- Nothing ships without approval

**Medium term (sales team use case):**
- Sales pipeline defined in ~15 lines of YAML
- Lead qualification gates work exactly like code review gates
- Same AOF primitives, different domain
- Zero software-specific concepts leaked into config

**Long term (any team, any process):**
- Workflow gates are a core AOF primitive, as fundamental as tasks and scheduler
- Teams define their own gates without thinking about implementation
- Observability dashboard shows gate performance across all projects
- Rejection loops are normal, expected, and well-instrumented

---

## Questions for Architect

1. Should gate history be in task frontmatter or separate files?
2. How do we handle race conditions (two agents completing same gate simultaneously)?
3. Should conditional gate logic support complex expressions or just simple predicates?
4. How do we version workflow definitions if config changes after tasks are in flight?
5. Should rejection loop-back support skipping multiple gates (e.g., test rejects back to implement, skipping code-review)?

---

**Next step:** Read this brief, review AOF vision doc and existing architecture, then draft the design doc. Let me know when you're ready to discuss trade-offs.

— Product Owner
