# Protocols Primitive Design (P2.3+)

**Status:** Draft (design-only, no implementation yet)
**Owner:** SWE Architect
**Updated:** 2026-02-09

---

## Objective
Define the **Protocols** primitive for AOF: Resume, Message Routing, Completion, and Handoff. These protocols establish deterministic, filesystem-first coordination between AOF, OpenClaw agents, and task artifacts.

## Constraints (must hold)
- **Filesystem-first** (no DB). Artifacts live in `dataDir/`.
- **Deterministic core** (no stochastic behavior; all state transitions explicit).
- Must work with current executor (`POST /tools/invoke` with `sessions_spawn`).
- **No nested fan-out**: OpenClaw sub-agents cannot spawn sub-agents.
- Task IDs match `/^TASK-\d{4}-\d{2}-\d{2}-\d{3}$/`.
- New tasks are created in `~/.openclaw/aof/tasks/ready/`.

---

## Shared Concepts

### Protocol Envelope (AOF/1)
All protocol messages use a shared JSON envelope to allow deterministic parsing and routing.

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "handoff.request",
  "taskId": "TASK-2026-02-09-057",
  "parentTaskId": "TASK-2026-02-07-001",
  "fromAgent": "swe-backend",
  "toAgent": "swe-qa",
  "sentAt": "2026-02-09T21:00:00.000Z",
  "messageId": "optional-string",
  "payload": { "...": "..." }
}
```

**Message detection** (in `message_received` hook):
1. If event payload already includes a parsed object with `protocol === "aof"`, route it.
2. Else, if message content is JSON, parse and validate.
3. Else, if message content starts with `AOF/1 `, parse the JSON substring.

**Core message types (v1):**
- `handoff.request` / `handoff.accepted` / `handoff.rejected`
- `status.update` (progress, blockers, mid-task state)
- `completion.report` (done / blocked / needs_review / partial)

Unknown/invalid messages are ignored (log-only). Protocol messages are **idempotent** by task state: if the task is already in the target status, no-op.

### Run Artifacts Location
To avoid churn when tasks move across status directories, run artifacts live under:
```
<dataDir>/runs/<taskId>/run.json
<dataDir>/runs/<taskId>/run_heartbeat.json
<dataDir>/runs/<taskId>/run_result.json   (proposed)
```
This aligns with the existing `recovery/run-artifacts` module and keeps the artifacts stable across task transitions.

### Status Mapping (Completion → Task Status)
| Completion signal | Task status transition |
|---|---|
| `done` | `in-progress → review → done` (same as `aof_task_complete`) |
| `blocked` | `in-progress → blocked` |
| `needs_review` | `in-progress → review` |
| `partial` | `in-progress → review` |

---

## Protocol 1 — Resume Protocol (P2.3)

### Purpose
Recover safely from interrupted executions. Ensure tasks resume or are reclaimed deterministically.

### Interfaces & Artifacts
- **run.json** (existing): Created on lease acquisition.
- **run_heartbeat.json** (existing): Periodic liveness signal.
- **run_result.json** (proposed): Completion/partial state written by protocol handler.

### Event Flow
1. **Dispatch** → `acquireLease()` writes `run.json` + initial heartbeat.
2. **Executor heartbeat** → periodic `writeHeartbeat()`.
3. **Scheduler poll**:
   - Read all `in-progress` tasks.
   - Check for stale heartbeats (`checkStaleHeartbeats`).
   - If stale: read `run_result.json`.
     - `partial`/`needs_review` → transition to **review**.
     - `done` → transition to **review → done**.
     - `blocked` → transition to **blocked**.
     - no result → **reclaim** (transition to **ready**) + mark run artifact expired.

### Error Cases
- **Missing run artifacts**: treat as resumable; do not fail.
- **Heartbeat missing**: skip stale evaluation (task may have been started before protocol).
- **Invalid run_result**: log `protocol.message.rejected`; transition unchanged.
- **Task already transitioned**: no-op (idempotent).

### Integration Points
- `src/recovery/run-artifacts.ts`: add read/write for `run_result.json`.
- `src/dispatch/scheduler.ts`: refine stale heartbeat handling with `run_result.json`.
- `src/events/logger.ts`: log recovery transitions.
- `src/events/notifier.ts`: notify `review` / `blocked` as per policy.

---

## Protocol 2 — Message Routing Protocol

### Purpose
Interpret `message_received` events and route AOF protocol messages to the correct handler (handoff, status update, completion).

### Interfaces
- **Protocol Router** (new module):
  - `parseProtocolMessage(event)` → `ProtocolEnvelope | null`
  - `route(message)` → handler result

### Status Update Message (`type: "status.update"`)
Used for mid-task progress or blockers without full completion.

Example payload:
```json
{
  "taskId": "TASK-2026-02-09-057",
  "agentId": "swe-backend",
  "status": "blocked",
  "progress": "Implemented core logic; waiting on API key",
  "blockers": ["Awaiting API key"],
  "notes": "ETA after credentials arrive"
}
```

**Routing behavior:**
- If `status` provided → map to `aof_task_update` (transition) with reason.
- If only `progress/notes` → append to task body (or write handoff note) without transition.

### Event Flow
1. OpenClaw adapter receives `message_received`.
2. AOF service passes event to `ProtocolRouter`.
3. Router validates envelope (Zod schema).
4. Handler updates store/run artifacts and logs events.

### Error Cases
- Invalid JSON → ignored, logged.
- Unknown `type` → ignored, logged (`protocol.message.unknown`).
- Task not found → log + notify `#aof-alerts` (non-fatal).

### Integration Points
- `src/openclaw/adapter.ts`: no change; event already wired.
- `src/service/aof-service.ts`: enhance `handleMessageReceived` to call router, then `triggerPoll`.
- `src/events/logger.ts`: new events for protocol handling.

---

## Protocol 3 — Completion Protocol

### Purpose
Standardize how agents signal **done / blocked / needs review / partial progress** and ensure deterministic task transitions.

### Interfaces
**Completion Report** (`run_result.json` or protocol message payload):
```json
{
  "taskId": "TASK-2026-02-09-057",
  "agentId": "swe-backend",
  "completedAt": "2026-02-09T21:10:00.000Z",
  "outcome": "partial",
  "summaryRef": "outputs/summary.md",
  "handoffRef": "outputs/handoff.md",
  "deliverables": ["src/foo.ts"],
  "tests": { "total": 120, "passed": 120, "failed": 0 },
  "blockers": ["Awaiting API key"],
  "notes": "Implemented core logic; needs QA review."
}
```

**How agents signal completion:**
- Preferred: send protocol message `type: "completion.report"` (router writes `run_result.json`).
- Alternative: call `aof_task_complete` or `aof_task_update` (still valid; protocol reconciles).

### Event Flow
1. Agent sends `completion.report` message.
2. Router writes `run_result.json` and logs `task.completed` or `task.transitioned`.
3. `session_end` hook triggers a completion check:
   - If `run_result.json` exists, apply status transition mapping.
   - If task already in target status, no-op.

### Error Cases
- Missing summary/handoff files: transition still proceeds; log warning.
- Conflicting state (e.g., task already done): no-op.

### Integration Points
- `src/context/summary.ts` and `src/context/handoff.ts`: used for summary/handoff artifacts.
- `src/store/task-store.ts`: transitions as per mapping table.
- `src/events/logger.ts`: log completion events.
- `src/events/notifier.ts`: notify on `review` / `blocked` / `done`.

---

## Protocol 4 — Handoff Protocol (Delegation)

### Purpose
Formalize delegation handoffs with structured context and acceptance criteria between parent and child tasks.

### Interfaces
**Handoff Request** (`type: "handoff.request"`):
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

**Handoff Artifacts (filesystem-first):**
- `tasks/<status>/<childId>/inputs/handoff.json` (authoritative)
- `tasks/<status>/<childId>/inputs/handoff.md` (human-readable)

### Flow
1. Parent creates child task with `parentId` (existing delegation module).
2. AOF writes handoff artifacts into child `inputs/`.
3. AOF logs `delegation.requested`.
4. Child acknowledges with `handoff.accepted` or `handoff.rejected` message.
   - Accept → log `delegation.accepted`.
   - Reject → transition child to `blocked` or `ready` with reason.

### Nested Fan‑Out Guard
- Maintain `metadata.delegationDepth` (parent depth + 1).
- If depth > 1, reject delegation with `handoff.rejected` and log warning.

### Error Cases
- Parent task missing → reject handoff; log `delegation.rejected`.
- Invalid acceptance criteria → still accept but log schema error.

### Integration Points
- `src/delegation/index.ts`: continue generating pointer files; extend to generate handoff artifacts.
- `src/context/handoff.ts`: separate from delegation handoff (this remains for progress handoff notes).
- `src/events/logger.ts`: use existing `delegation.*` events.

---

## Proposed Schema/Type Updates

### New Schemas (in `src/schemas/`)
1. **`protocol.ts`**
   - `ProtocolEnvelope`
   - `ProtocolMessageType` enum
   - `CompletionReportPayload`
   - `StatusUpdatePayload`
   - `HandoffRequestPayload`
   - `HandoffAckPayload`

2. **`run.ts`**
   - Add `RunResult` (or `CompletionReport`) schema.
   - Optionally extend `RunArtifact` with `sessionId`, `endedAt`, `resultRef`.

3. **`event.ts`** (if needed)
   - Add event types: `protocol.message.received`, `protocol.message.rejected`.
   - (Optional) `handoff.requested/accepted/rejected` can reuse existing delegation events.

### TypeScript Types (optional in `src/types/`)
- `ProtocolHandler` interface (for router registry).
- `ProtocolParseResult` union (success/error).

---

## Implementation Plan (TASK‑057+)

> **All new tasks must be created in:** `~/.openclaw/aof/tasks/ready/`

### TASK-2026-02-09-057 — Protocol schemas + run result artifact
**Scope:** Add `protocol.ts` schemas and `run_result.json` schema + read/write helpers.
**Acceptance criteria:**
- New schemas validate example payloads.
- `run_result.json` read/write works in `<dataDir>/runs/<taskId>/`.
- Schema exports included in `src/schemas/index.ts`.
**Est. tests:** 8 (schema parsing + run_result IO).

### TASK-2026-02-09-058 — Protocol router + message_received integration
**Scope:** Implement protocol parsing and routing; integrate into `AOFService.handleMessageReceived`.
**Acceptance criteria:**
- Valid protocol messages route to correct handler.
- Invalid/unknown messages are ignored but logged.
- No changes to non-protocol messages.
**Est. tests:** 10 (parse variants, routing, error handling).

### TASK-2026-02-09-059 — Completion protocol
**Scope:** Completion handler writes `run_result.json`, triggers task transitions on `session_end`.
**Acceptance criteria:**
- `done` → review → done.
- `blocked` → blocked.
- `needs_review` / `partial` → review.
- Idempotent when task already transitioned.
**Est. tests:** 12 (unit + integration with store transitions).

### TASK-2026-02-09-060 — Handoff protocol (delegation)
**Scope:** Generate handoff artifacts + handle `handoff.accepted/rejected` messages.
**Acceptance criteria:**
- Child tasks receive `inputs/handoff.json` + `.md`.
- Nested fan-out is rejected (depth > 1).
- Delegation events logged.
**Est. tests:** 10 (handoff artifact generation + depth guard).

### TASK-2026-02-09-061 — Resume protocol enhancements
**Scope:** Stale heartbeat flow uses `run_result.json` to decide reclaim vs review vs blocked.
**Acceptance criteria:**
- Stale heartbeat + no result → requeue to ready.
- Stale + partial/needs_review → review.
- Stale + done → review → done.
- Run artifact marked expired on reclaim.
**Est. tests:** 6 (scheduler integration).

---

## Open Questions
- Should `done` always pass through `review`, or should tasks flagged with `metadata.reviewRequired=false` go directly to `done`?
- Should protocol messages be signed/validated beyond schema (e.g., known agent IDs)?
- Is `run_result.json` sufficient, or should completion be embedded in `run.json` to reduce files?

---

## Summary
This design formalizes protocol primitives while respecting AOF’s deterministic, filesystem-first architecture. Resume, routing, completion, and handoff protocols share a common envelope and consistent artifact strategy, integrate cleanly with existing modules, and remain compatible with the current OpenClaw executor.
