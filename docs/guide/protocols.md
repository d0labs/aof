# AOF Protocols User Guide

**Version:** AOF/1 (Protocol Version 1)  
**Audience:** Agent developers building on the AOF task framework  
**Status:** Production (P2.3+)

---

## Table of Contents

1. [Overview](#overview)
2. [Protocol Envelope](#protocol-envelope)
3. [Message Types](#message-types)
4. [Completion Protocol](#completion-protocol)
5. [Status Update Protocol](#status-update-protocol)
6. [Handoff Protocol (Delegation)](#handoff-protocol-delegation)
7. [Resume Protocol](#resume-protocol)
8. [Error Handling](#error-handling)
9. [Examples](#examples)

---

## Overview

### What Are Protocols?

AOF Protocols provide **structured inter-agent communication** for task lifecycle management. Instead of agents using unstructured messages or ad-hoc state updates, protocols define standardized message formats for:

- **Completion reporting** — how agents signal task completion with outcomes (done/blocked/needs_review/partial)
- **Status updates** — mid-task progress, blockers, and work log entries
- **Handoffs** — delegation with structured acceptance criteria and context
- **Resume/recovery** — deterministic recovery from interrupted executions

### Why Protocols Exist

AOF is a **filesystem-first, deterministic task orchestration system**. Protocols enforce:

1. **Predictable state transitions** — no stochastic behavior; all state changes are explicit
2. **Crash recovery** — tasks can resume safely after interruptions
3. **Audit trail** — all protocol messages are logged with timestamps and actors
4. **Decoupled communication** — agents don't need direct connections; all state lives in the filesystem

### How Protocols Fit Into AOF's Task Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                     AOF Task Lifecycle                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  backlog → ready → in-progress → review → done              │
│                       ↓             ↑                        │
│                    blocked  ────────┘                        │
│                                                              │
│  Protocol touchpoints:                                       │
│  • ready → in-progress: acquireLease, write run.json        │
│  • in-progress: heartbeat updates (run_heartbeat.json)      │
│  • completion.report: write run_result.json                 │
│  • session_end: apply run_result → status transition        │
│  • stale heartbeat: consult run_result or reclaim           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Key integration points:**

- **Dispatch** → acquires lease, writes `run.json`, starts heartbeat
- **Agent execution** → sends protocol messages during task work
- **session_end hook** → reads `run_result.json`, applies completion transitions
- **Scheduler poll** → checks stale heartbeats, consults `run_result.json` for recovery

---

## Protocol Envelope

All protocol messages use a common **JSON envelope** for deterministic parsing and routing.

### Envelope Structure

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "completion.report",
  "taskId": "TASK-2026-02-09-057",
  "fromAgent": "swe-backend",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-09T21:00:00.000Z",
  "payload": {
    "...": "type-specific payload"
  }
}
```

### Envelope Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol` | `"aof"` | ✅ | Protocol identifier (must be `"aof"`) |
| `version` | `1` | ✅ | Protocol version (must be `1`) |
| `type` | `ProtocolMessageType` | ✅ | Message type (see [Message Types](#message-types)) |
| `taskId` | `TASK-YYYY-MM-DD-NNN` | ✅ | Task ID matching `/^TASK-\d{4}-\d{2}-\d{2}-\d{3}$/` |
| `fromAgent` | `string` | ✅ | Sending agent ID |
| `toAgent` | `string` | ✅ | Receiving agent ID (typically `"dispatcher"`) |
| `sentAt` | `ISO 8601 datetime` | ✅ | Timestamp when message was sent |
| `payload` | `object` | ✅ | Type-specific payload (see message types below) |

### Message Detection

The protocol router (`ProtocolRouter`) detects protocol messages from `message_received` events in this order:

1. **Parsed object with `protocol === "aof"`** — if the event payload is already a parsed object
2. **JSON content** — if the message content is valid JSON
3. **AOF/1 prefix** — if the message content starts with `"AOF/1 "`, parse the JSON substring

**Example with AOF/1 prefix:**

```
AOF/1 {"protocol":"aof","version":1,"type":"completion.report",...}
```

### Validation

All envelopes are validated against Zod schemas:

- **Invalid JSON** → logged as `protocol.message.rejected` with reason `invalid_json`
- **Invalid envelope** → logged as `protocol.message.rejected` with reason `invalid_envelope`
- **Unknown type** → logged as `protocol.message.unknown`

Protocol messages are **idempotent** by task state: if the task is already in the target status, the router performs no-op.

---

## Message Types

### Supported Message Types (v1)

| Type | Purpose | Handler |
|------|---------|---------|
| `completion.report` | Agent signals task completion with outcome | Writes `run_result.json`, applies completion transitions |
| `status.update` | Mid-task progress or blocker update | Updates task body (work log) or transitions status |
| `handoff.request` | Delegation request with acceptance criteria | Writes handoff artifacts to child task `inputs/` |
| `handoff.accepted` | Child agent accepts handoff | Logs `delegation.accepted` |
| `handoff.rejected` | Child agent rejects handoff | Transitions child to `blocked`, logs `delegation.rejected` |

### Message Type Enum (TypeScript)

```typescript
export const ProtocolMessageType = z.enum([
  "handoff.request",
  "handoff.accepted",
  "handoff.rejected",
  "status.update",
  "completion.report",
]);
```

---

## Completion Protocol

### Purpose

The Completion Protocol standardizes how agents signal **task completion** with structured outcomes. This ensures deterministic task transitions and provides a clear audit trail.

### Completion Outcomes

| Outcome | Meaning | Task Transition |
|---------|---------|-----------------|
| `done` | Task completed successfully | `in-progress → review` (if `reviewRequired=true`, default)<br>`in-progress → review → done` (if `reviewRequired=false`) |
| `blocked` | Task cannot proceed (e.g., missing credentials) | `in-progress → blocked` |
| `needs_review` | Task needs human review before proceeding | `in-progress → review` |
| `partial` | Task partially completed (e.g., 80% done) | `in-progress → review` |

**Note:** Transitions are applied sequentially. If `reviewRequired=false`, `done` outcome applies both `review` and `done` transitions in sequence.

### How Agents Report Completion

Agents send a `completion.report` message, which triggers the protocol router to:

1. Write `run_result.json` to `<dataDir>/runs/<taskId>/run_result.json`
2. Log `task.completed` event
3. On `session_end` hook, read `run_result.json` and apply completion transitions

**Alternative (legacy):** Agents can still call `aof_task_complete` or `aof_task_update` tools. The protocol reconciles both approaches.

### Completion Report Payload

```typescript
{
  "outcome": "done" | "blocked" | "needs_review" | "partial",
  "summaryRef": "outputs/summary.md",       // Path to summary file
  "deliverables": ["src/foo.ts", "..."],    // Files produced
  "tests": {
    "total": 120,
    "passed": 120,
    "failed": 0
  },
  "blockers": ["Awaiting API key"],         // Required for "blocked" outcome
  "notes": "Optional completion notes"
}
```

### Payload Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `outcome` | `CompletionOutcome` | ✅ | Task outcome (done/blocked/needs_review/partial) |
| `summaryRef` | `string` | ✅ | Relative path to summary file (typically `outputs/summary.md`) |
| `deliverables` | `string[]` | ❌ | List of files produced (default: `[]`) |
| `tests` | `TestReport` | ✅ | Test results (total/passed/failed) |
| `blockers` | `string[]` | ❌ | Blocking issues (default: `[]`) |
| `notes` | `string` | ✅ | Completion notes or context |

### run_result.json Schema

When a `completion.report` message is received, the router writes `run_result.json`:

```json
{
  "taskId": "TASK-2026-02-09-057",
  "agentId": "swe-backend",
  "completedAt": "2026-02-09T21:10:00.000Z",
  "outcome": "done",
  "summaryRef": "outputs/summary.md",
  "handoffRef": "outputs/handoff.md",
  "deliverables": ["src/foo.ts", "src/bar.ts"],
  "tests": {
    "total": 120,
    "passed": 120,
    "failed": 0
  },
  "blockers": [],
  "notes": "All acceptance criteria met. Tests passing."
}
```

**Location:** `<dataDir>/runs/<taskId>/run_result.json`

### Lifecycle

```
1. Agent sends completion.report message
     ↓
2. Router validates envelope
     ↓
3. Router writes run_result.json
     ↓
4. Router logs task.completed
     ↓
5. session_end hook triggered
     ↓
6. Router reads run_result.json
     ↓
7. Router applies completion transitions (resolveCompletionTransitions)
     ↓
8. Task moves to target status (review/blocked/done)
```

### Transition Logic

The `resolveCompletionTransitions` function maps outcomes to transitions:

```typescript
function resolveCompletionTransitions(
  task: Task,
  outcome: "done" | "blocked" | "needs_review" | "partial"
): TaskStatus[] {
  const reviewRequired = task.frontmatter.metadata?.reviewRequired !== false;

  if (outcome === "done") {
    if (task.frontmatter.status === "done") return []; // Already done
    if (reviewRequired) return ["review"];
    return ["review", "done"]; // Skip review if reviewRequired=false
  }

  if (outcome === "blocked") return ["blocked"];
  if (outcome === "needs_review") return ["review"];
  if (outcome === "partial") return ["review"];

  return [];
}
```

### Error Cases

| Condition | Behavior |
|-----------|----------|
| Task not found | Log `protocol.message.rejected` with reason `task_not_found` |
| Invalid outcome | Zod validation fails; message rejected |
| Task already in target status | No-op (idempotent) |
| Missing summary/handoff files | Transition proceeds; warning logged |

---

## Status Update Protocol

### Purpose

Status updates allow agents to send **mid-task progress** or **blocker information** without triggering full completion. Useful for long-running tasks or when agents need to report blockers without ending the session.

### Status Update Payload

```typescript
{
  "taskId": "TASK-2026-02-09-057",
  "agentId": "swe-backend",
  "status": "blocked",                    // Optional: trigger status transition
  "progress": "Implemented core logic",   // Optional: progress text
  "blockers": ["Awaiting API key"],       // Optional: blocker list
  "notes": "ETA after credentials arrive" // Optional: additional notes
}
```

**Validation:** At least one of `status`, `progress`, `blockers`, or `notes` must be provided.

### Payload Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | `TaskId` | ✅ | Task ID |
| `agentId` | `string` | ✅ | Agent sending the update |
| `status` | `TaskStatus` | ❌ | Target status (triggers transition if different from current) |
| `progress` | `string` | ❌ | Progress text |
| `blockers` | `string[]` | ❌ | List of blockers |
| `notes` | `string` | ❌ | Additional notes |

### Routing Behavior

1. **If `status` is provided:**
   - Validate transition with `isValidTransition(current, target)`
   - Transition task to target status
   - Build reason from `blockers` → `notes` → `progress` (first available)
   - Log `task.transitioned` event
   - Notify if target status is `review`, `blocked`, or `done`

2. **If no `status` (or status unchanged):**
   - Append work log entry to task body (if `progress`, `notes`, or `blockers` present)
   - Work log format: `- <timestamp> Progress: ... | Notes: ... | Blockers: ...`

### Work Log Entry Format

```markdown
## Work Log

- 2026-02-09T21:05:00.000Z Progress: Implemented core logic | Notes: ETA after credentials arrive | Blockers: Awaiting API key
```

### Error Cases

| Condition | Behavior |
|-----------|----------|
| Task not found | Log `protocol.message.rejected` with reason `task_not_found` |
| Invalid transition | No transition; work log appended instead |
| No status/progress/notes/blockers | Validation fails; message rejected |

---

## Handoff Protocol (Delegation)

### Purpose

The Handoff Protocol formalizes **delegation** between parent and child tasks with:

- Structured acceptance criteria
- Expected outputs
- Context references
- Constraints (e.g., "no new dependencies")
- **Depth guard:** nested delegation is blocked (depth > 1)

### Delegation Flow

```
1. Parent agent creates child task (via delegation module)
     ↓
2. Parent sends handoff.request message
     ↓
3. Router writes handoff artifacts:
     • <childTaskDir>/inputs/handoff.json
     • <childTaskDir>/inputs/handoff.md
     ↓
4. Router logs delegation.requested
     ↓
5. Child agent reads handoff artifacts
     ↓
6. Child sends handoff.accepted or handoff.rejected
     ↓
7. Router logs delegation.accepted or delegation.rejected
     (If rejected: child task → blocked)
```

### Handoff Request Payload

```typescript
{
  "taskId": "TASK-2026-02-09-060",          // Child task ID
  "parentTaskId": "TASK-2026-02-09-057",    // Parent task ID
  "fromAgent": "swe-backend",
  "toAgent": "swe-qa",
  "acceptanceCriteria": [
    "All tests pass",
    "Update docs"
  ],
  "expectedOutputs": [
    "tests/report.md",
    "docs/QA.md"
  ],
  "contextRefs": [
    "tasks/in-progress/TASK-2026-02-09-057.md",
    "tasks/in-progress/TASK-2026-02-09-057/outputs/handoff.md"
  ],
  "constraints": ["No new dependencies"],
  "dueBy": "2026-02-10T12:00:00.000Z"       // ISO 8601 datetime
}
```

### Payload Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | `TaskId` | ✅ | Child task ID (must match envelope `taskId`) |
| `parentTaskId` | `TaskId` | ✅ | Parent task ID |
| `fromAgent` | `string` | ✅ | Parent agent |
| `toAgent` | `string` | ✅ | Target child agent |
| `acceptanceCriteria` | `string[]` | ❌ | Acceptance criteria (default: `[]`) |
| `expectedOutputs` | `string[]` | ❌ | Expected output files (default: `[]`) |
| `contextRefs` | `string[]` | ❌ | Context file references (default: `[]`) |
| `constraints` | `string[]` | ❌ | Constraints (default: `[]`) |
| `dueBy` | `ISO 8601 datetime` | ✅ | Deadline |

### Handoff Artifacts

When a `handoff.request` is received, the router writes two artifacts:

#### 1. `inputs/handoff.json` (authoritative)

```json
{
  "taskId": "TASK-2026-02-09-060",
  "parentTaskId": "TASK-2026-02-09-057",
  "fromAgent": "swe-backend",
  "toAgent": "swe-qa",
  "acceptanceCriteria": ["All tests pass", "Update docs"],
  "expectedOutputs": ["tests/report.md", "docs/QA.md"],
  "contextRefs": [
    "tasks/in-progress/TASK-2026-02-09-057.md",
    "tasks/in-progress/TASK-2026-02-09-057/outputs/handoff.md"
  ],
  "constraints": ["No new dependencies"],
  "dueBy": "2026-02-10T12:00:00.000Z"
}
```

**Location:** `<dataDir>/tasks/<status>/TASK-2026-02-09-060/inputs/handoff.json`

#### 2. `inputs/handoff.md` (human-readable)

```markdown
# Handoff Request

**From:** swe-backend
**To:** swe-qa
**Due By:** 2026-02-10T12:00:00.000Z

## Acceptance Criteria

- All tests pass
- Update docs

## Expected Outputs

- tests/report.md
- docs/QA.md

## Context References

- tasks/in-progress/TASK-2026-02-09-057.md
- tasks/in-progress/TASK-2026-02-09-057/outputs/handoff.md

## Constraints

- No new dependencies
```

**Location:** `<dataDir>/tasks/<status>/TASK-2026-02-09-060/inputs/handoff.md`

### Delegation Depth Guard

**Constraint:** OpenClaw sub-agents **cannot spawn sub-agents** (no nested fan-out).

The router maintains `metadata.delegationDepth` on tasks:

- Parent depth 0 → child depth 1 (allowed)
- Parent depth 1 → child depth 2 (rejected)

**Depth calculation:**

```typescript
const parentDepth = 
  typeof parentTask.frontmatter.metadata?.delegationDepth === "number"
    ? parentTask.frontmatter.metadata.delegationDepth
    : 0;

if (parentDepth + 1 > 1) {
  // Reject delegation
  await logger.log("delegation.rejected", fromAgent, {
    taskId: childTaskId,
    payload: { reason: "nested_delegation" }
  });
  return;
}
```

### Handoff Acceptance/Rejection

#### handoff.accepted

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "handoff.accepted",
  "taskId": "TASK-2026-02-09-060",
  "fromAgent": "swe-qa",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-09T21:15:00.000Z",
  "payload": {
    "taskId": "TASK-2026-02-09-060",
    "accepted": true
  }
}
```

**Behavior:** Logs `delegation.accepted`, no status transition.

#### handoff.rejected

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "handoff.rejected",
  "taskId": "TASK-2026-02-09-060",
  "fromAgent": "swe-qa",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-09T21:15:00.000Z",
  "payload": {
    "taskId": "TASK-2026-02-09-060",
    "accepted": false,
    "reason": "Insufficient context to proceed"
  }
}
```

**Behavior:**
- Transitions child task to `blocked`
- Logs `task.transitioned` (child status → blocked)
- Logs `delegation.rejected` with reason

### Error Cases

| Condition | Behavior |
|-----------|----------|
| Task not found | Log `protocol.message.rejected` + `delegation.rejected` with reason `task_not_found` |
| Parent task not found | Log `delegation.rejected` with reason `parent_not_found` |
| Nested delegation (depth > 1) | Log `delegation.rejected` with reason `nested_delegation` |
| `taskId` mismatch (payload vs envelope) | Log `protocol.message.rejected` with reason `taskId_mismatch` |
| Invalid acceptance criteria | Handoff proceeds; schema error logged |

---

## Resume Protocol

### Purpose

The Resume Protocol provides **deterministic crash recovery** for interrupted executions. When an agent session ends unexpectedly (stale heartbeat), the scheduler consults `run_result.json` to decide whether to:

- **Reclaim** the task (requeue to `ready`)
- **Transition** to `review`, `blocked`, or `done` based on partial progress

This ensures tasks don't get stuck in `in-progress` and enables outcome-driven recovery (not blind requeue).

### Run Artifacts Location

To avoid churn when tasks move across status directories, run artifacts live under:

```
<dataDir>/runs/<taskId>/run.json
<dataDir>/runs/<taskId>/run_heartbeat.json
<dataDir>/runs/<taskId>/run_result.json
```

**Key principle:** Artifacts remain stable regardless of task status transitions.

### Artifacts

#### 1. run.json

Written when a lease is acquired (`acquireLease`).

```json
{
  "taskId": "TASK-2026-02-09-057",
  "agentId": "swe-backend",
  "startedAt": "2026-02-09T20:55:00.000Z",
  "status": "running",
  "artifactPaths": {
    "inputs": "inputs/",
    "work": "work/",
    "output": "output/"
  },
  "metadata": {}
}
```

#### 2. run_heartbeat.json

Updated periodically by the executor (`writeHeartbeat`).

```json
{
  "taskId": "TASK-2026-02-09-057",
  "agentId": "swe-backend",
  "lastHeartbeat": "2026-02-09T21:00:00.000Z",
  "beatCount": 5,
  "expiresAt": "2026-02-09T21:05:00.000Z"  // lastHeartbeat + ttlMs
}
```

**Default TTL:** 5 minutes (300,000 ms)

#### 3. run_result.json

Written when `completion.report` is received (see [Completion Protocol](#completion-protocol)).

```json
{
  "taskId": "TASK-2026-02-09-057",
  "agentId": "swe-backend",
  "completedAt": "2026-02-09T21:10:00.000Z",
  "outcome": "partial",
  "summaryRef": "outputs/summary.md",
  "handoffRef": "outputs/handoff.md",
  "deliverables": ["src/foo.ts"],
  "tests": { "total": 10, "passed": 8, "failed": 2 },
  "blockers": [],
  "notes": "80% complete; needs final polish"
}
```

### Stale Heartbeat Flow

The scheduler polls `in-progress` tasks and checks for stale heartbeats:

```
1. Scheduler reads all in-progress tasks
     ↓
2. For each task, read run_heartbeat.json
     ↓
3. Check if heartbeat.expiresAt <= now
     ↓
4. If stale:
     a. Read run_result.json
     b. If run_result exists:
          → Apply outcome-driven transitions
     c. If no run_result:
          → Reclaim to ready (mark run artifact expired)
```

**Code path:** `src/dispatch/scheduler.ts` → `stale_heartbeat` action

```typescript
case "stale_heartbeat":
  const runResult = await readRunResult(store, action.taskId);
  
  if (!runResult) {
    // No run result → reclaim to ready
    await store.transition(action.taskId, "ready", { 
      reason: "stale_heartbeat_reclaim" 
    });
    await markRunArtifactExpired(store, action.taskId, "stale_heartbeat");
  } else {
    // Run result exists → apply outcome-driven transitions
    const transitions = resolveCompletionTransitions(staleTask, runResult.outcome);
    for (const targetStatus of transitions) {
      await store.transition(action.taskId, targetStatus, { 
        reason: `stale_heartbeat_${runResult.outcome}` 
      });
    }
  }
  break;
```

### Outcome-Driven Recovery vs. Blind Requeue

| Scenario | run_result.json | Recovery Behavior |
|----------|-----------------|-------------------|
| Agent crashed mid-work, no completion signal | Missing | **Blind requeue:** Task → `ready` (can be retried) |
| Agent reported `partial` before crash | `outcome: "partial"` | Task → `review` (partial work preserved) |
| Agent reported `done` but session died | `outcome: "done"` | Task → `review` → `done` (completion honored) |
| Agent reported `blocked` before crash | `outcome: "blocked"` | Task → `blocked` (blocker preserved) |

**Benefit:** Preserves partial progress and avoids losing work when agents crash after reporting completion.

### session_end Hook

When `session_end` is triggered (e.g., agent terminates normally), the `AOFService` calls `ProtocolRouter.handleSessionEnd()`:

```typescript
async handleSessionEnd(): Promise<void> {
  const inProgress = await this.store.list({ status: "in-progress" });
  for (const task of inProgress) {
    const runResult = await readRunResult(this.store, task.frontmatter.id);
    if (!runResult) continue;
    await this.applyCompletionOutcome(task, {
      actor: runResult.agentId,
      outcome: runResult.outcome,
      notes: runResult.notes,
      blockers: runResult.blockers,
    });
  }
}
```

This ensures completion transitions are applied even if the agent dies immediately after sending `completion.report`.

### Error Cases

| Condition | Behavior |
|-----------|----------|
| Missing run artifacts | Treat as resumable; do not fail |
| Heartbeat missing | Skip stale evaluation (task may predate protocol) |
| Invalid `run_result.json` | Log `protocol.message.rejected`; no transition |
| Task already transitioned | No-op (idempotent) |

---

## Error Handling

### Validation Errors

All protocol messages are validated with Zod schemas. Invalid messages are **ignored** (non-fatal) and logged.

| Error Type | Event Logged | Reason |
|------------|--------------|--------|
| Invalid JSON | `protocol.message.rejected` | `invalid_json` |
| Invalid envelope schema | `protocol.message.rejected` | `invalid_envelope` |
| Unknown message type | `protocol.message.unknown` | `type: <unknown-type>` |
| Task not found | `protocol.message.rejected` | `task_not_found` |

### Idempotency

Protocol handlers are **idempotent by task state**:

- If a task is already in the target status, no transition is applied
- If a handoff is re-sent, the router writes the same artifacts (no duplicate delegation)
- If a completion is re-sent with the same outcome, no additional transitions occur

### Conflict Resolution

| Conflict | Resolution |
|----------|------------|
| `completion.report` while task is `done` | No-op (task already done) |
| `status.update` to invalid status | No transition; work log appended instead |
| `handoff.request` with mismatched `taskId` | Reject with `taskId_mismatch` |
| Nested delegation (depth > 1) | Reject with `nested_delegation` |

### Logging

All protocol events are logged to `<dataDir>/events/`:

- `protocol.message.received` — valid message received
- `protocol.message.rejected` — validation failed
- `protocol.message.unknown` — unknown message type
- `task.completed` — completion report processed
- `task.transitioned` — status transition applied
- `delegation.requested` — handoff request processed
- `delegation.accepted` — handoff accepted
- `delegation.rejected` — handoff rejected

Events include timestamps, actor, taskId, and payload.

---

## Examples

### Example 1: Completion Report (Done)

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "completion.report",
  "taskId": "TASK-2026-02-09-057",
  "fromAgent": "swe-backend",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-09T21:10:00.000Z",
  "payload": {
    "outcome": "done",
    "summaryRef": "outputs/summary.md",
    "deliverables": [
      "src/api/users.ts",
      "src/api/auth.ts"
    ],
    "tests": {
      "total": 120,
      "passed": 120,
      "failed": 0
    },
    "blockers": [],
    "notes": "All acceptance criteria met. Tests passing. Ready for review."
  }
}
```

**Behavior:**
1. Router writes `run_result.json` with `outcome: "done"`
2. Logs `task.completed`
3. On `session_end`, task transitions: `in-progress → review` (if `reviewRequired=true`)

---

### Example 2: Completion Report (Blocked)

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "completion.report",
  "taskId": "TASK-2026-02-09-058",
  "fromAgent": "swe-backend",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-09T21:15:00.000Z",
  "payload": {
    "outcome": "blocked",
    "summaryRef": "outputs/summary.md",
    "deliverables": ["src/api/users.ts"],
    "tests": {
      "total": 50,
      "passed": 50,
      "failed": 0
    },
    "blockers": [
      "Awaiting API key for external service",
      "Need database credentials"
    ],
    "notes": "Implemented core logic. Cannot proceed without credentials."
  }
}
```

**Behavior:**
1. Router writes `run_result.json` with `outcome: "blocked"`
2. Logs `task.completed`
3. On `session_end`, task transitions: `in-progress → blocked`
4. Notification sent (if notifier configured)

---

### Example 3: Status Update (Progress)

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "status.update",
  "taskId": "TASK-2026-02-09-059",
  "fromAgent": "swe-qa",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-09T21:20:00.000Z",
  "payload": {
    "taskId": "TASK-2026-02-09-059",
    "agentId": "swe-qa",
    "progress": "Executed 50/100 test cases",
    "notes": "No issues found so far"
  }
}
```

**Behavior:**
1. Router appends work log entry to task body:
   ```markdown
   ## Work Log
   
   - 2026-02-09T21:20:00.000Z Progress: Executed 50/100 test cases | Notes: No issues found so far
   ```
2. No status transition (progress update only)

---

### Example 4: Status Update (With Transition)

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "status.update",
  "taskId": "TASK-2026-02-09-060",
  "fromAgent": "swe-qa",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-09T21:25:00.000Z",
  "payload": {
    "taskId": "TASK-2026-02-09-060",
    "agentId": "swe-qa",
    "status": "blocked",
    "blockers": ["Test environment unreachable"],
    "notes": "Cannot proceed until infrastructure is fixed"
  }
}
```

**Behavior:**
1. Router transitions task: `in-progress → blocked`
2. Logs `task.transitioned` with reason: `"Test environment unreachable"`
3. Notification sent (if notifier configured)

---

### Example 5: Handoff Request

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "handoff.request",
  "taskId": "TASK-2026-02-09-061",
  "fromAgent": "swe-backend",
  "toAgent": "swe-qa",
  "sentAt": "2026-02-09T21:30:00.000Z",
  "payload": {
    "taskId": "TASK-2026-02-09-061",
    "parentTaskId": "TASK-2026-02-09-057",
    "fromAgent": "swe-backend",
    "toAgent": "swe-qa",
    "acceptanceCriteria": [
      "All unit tests pass",
      "Integration tests pass",
      "Code coverage >= 80%"
    ],
    "expectedOutputs": [
      "tests/report.md",
      "coverage/report.html"
    ],
    "contextRefs": [
      "tasks/in-progress/TASK-2026-02-09-057.md",
      "tasks/in-progress/TASK-2026-02-09-057/outputs/handoff.md",
      "src/api/users.ts",
      "src/api/auth.ts"
    ],
    "constraints": [
      "No new dependencies",
      "Use existing test framework"
    ],
    "dueBy": "2026-02-10T12:00:00.000Z"
  }
}
```

**Behavior:**
1. Router verifies `taskId` matches envelope
2. Loads child task `TASK-2026-02-09-061` and parent `TASK-2026-02-09-057`
3. Checks delegation depth (parent depth 0 → child depth 1, allowed)
4. Writes handoff artifacts:
   - `tasks/ready/TASK-2026-02-09-061/inputs/handoff.json`
   - `tasks/ready/TASK-2026-02-09-061/inputs/handoff.md`
5. Logs `delegation.requested`

---

### Example 6: Handoff Accepted

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "handoff.accepted",
  "taskId": "TASK-2026-02-09-061",
  "fromAgent": "swe-qa",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-09T21:35:00.000Z",
  "payload": {
    "taskId": "TASK-2026-02-09-061",
    "accepted": true
  }
}
```

**Behavior:**
1. Logs `delegation.accepted`
2. No status transition (task remains in current status)

---

### Example 7: Handoff Rejected

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "handoff.rejected",
  "taskId": "TASK-2026-02-09-062",
  "fromAgent": "swe-qa",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-09T21:40:00.000Z",
  "payload": {
    "taskId": "TASK-2026-02-09-062",
    "accepted": false,
    "reason": "Insufficient context: no test plan provided"
  }
}
```

**Behavior:**
1. Router transitions child task: `ready → blocked`
2. Logs `task.transitioned` with reason: `"Insufficient context: no test plan provided"`
3. Logs `delegation.rejected`
4. Notification sent (if notifier configured)

---

### Example 8: Resume Protocol (Stale Heartbeat with run_result)

**Scenario:** Agent reported `partial` completion but crashed before `session_end`.

**Artifacts:**
- `run_heartbeat.json` expired (expiresAt in the past)
- `run_result.json` exists with `outcome: "partial"`

**Scheduler behavior:**
1. Detects stale heartbeat during poll
2. Reads `run_result.json` → `outcome: "partial"`
3. Applies transition: `in-progress → review`
4. Logs `task.transitioned` with reason: `"stale_heartbeat_partial"`

**Result:** Partial work is preserved; task moves to review for human inspection.

---

### Example 9: Resume Protocol (Stale Heartbeat without run_result)

**Scenario:** Agent crashed mid-work without sending `completion.report`.

**Artifacts:**
- `run_heartbeat.json` expired
- `run_result.json` does not exist

**Scheduler behavior:**
1. Detects stale heartbeat during poll
2. Reads `run_result.json` → not found
3. Reclaims task: `in-progress → ready`
4. Marks run artifact expired (`markRunArtifactExpired`)
5. Logs `task.transitioned` with reason: `"stale_heartbeat_reclaim"`

**Result:** Task is requeued for retry; no partial state assumed.

---

## Best Practices

### For Agent Developers

1. **Always send `completion.report` before session ends**
   - Even if outcome is `partial` or `blocked`
   - Ensures deterministic recovery if agent crashes

2. **Use `status.update` for long-running tasks**
   - Send progress updates every 5-10 minutes
   - Helps humans monitor task progress

3. **Send `handoff.accepted/rejected` promptly**
   - Don't leave delegations in limbo
   - Reject with clear reasons if context is insufficient

4. **Include detailed notes and blockers**
   - Makes debugging easier
   - Helps humans understand task state

5. **Test crash recovery scenarios**
   - Verify `run_result.json` is written before crash
   - Confirm stale heartbeat recovery works as expected

### For System Integrators

1. **Set appropriate heartbeat TTL**
   - Default: 5 minutes (300,000 ms)
   - Adjust based on task duration and network reliability

2. **Monitor `protocol.message.rejected` events**
   - Indicates validation failures or malformed messages
   - May reveal bugs in agent protocol implementation

3. **Configure notifications for `review` and `blocked` transitions**
   - Ensures humans are alerted when tasks need attention

4. **Use `reviewRequired=false` sparingly**
   - Only for fully automated tasks with high confidence
   - Default: all `done` outcomes go through review

---

## Versioning

**Current version:** `AOF/1` (Protocol Version 1)

Protocol messages include a `version` field. Future versions may introduce:

- New message types
- Additional payload fields
- Backward-compatible schema extensions

Agents should validate the `version` field and reject unsupported versions.

---

## Related Documentation

- [Protocols Design](../dev/protocols-design.md) — Design document and implementation plan
- Task Store API — Task lifecycle and status transitions
- Event Logger — Event logging and audit trail
- Delegation Module — Task delegation and handoff artifacts

---

## Support

For questions or issues:

1. Check event logs in `<dataDir>/events/`
2. Verify task state in `<dataDir>/tasks/<status>/`
3. Inspect run artifacts in `<dataDir>/runs/<taskId>/`
4. Review protocol message validation errors in logs

**Protocol validation errors are non-fatal** — invalid messages are logged and ignored. AOF continues processing valid messages.
