---
name: aof
description: >
  Work with AOF (Agentic Ops Fabric) — deterministic multi-agent orchestration with
  tool-based task management, org-chart governance, workflow gates, and structured
  inter-agent protocols. Use when: creating/managing tasks, coordinating multi-agent
  handoffs, checking system status, or completing assigned work.
version: 2.0.0
requires:
  bins: [node]
---

# AOF — Agentic Ops Fabric

Deterministic orchestration for multi-agent systems. No LLMs in the control plane.

**Key distinction:** Agents interact with AOF through **plugin tools** (MCP). The CLI
is for human operators doing setup, debugging, and maintenance only.

---

## Agent Tools Reference

AOF exposes 5 tools via the OpenClaw plugin. These are your primary interface.

### `aof_dispatch` — Create & route a task

Creates a task, promotes it to `ready`, and dispatches it to the assigned agent.

```json
{
  "title": "Implement rate limiting middleware",
  "brief": "Add token-bucket rate limiting to the API gateway. Config should live in org-chart, not hardcoded.",
  "priority": "high",
  "assignedAgent": "swe-backend",
  "ownerTeam": "swe",
  "checklist": [
    "429 responses for >100 req/min per token",
    "Config in org-chart",
    "Tests ≥ 95% coverage"
  ],
  "inputs": ["outputs/api-spec.yaml"],
  "actor": "main"
}
```

**Returns:** `{ taskId, status, assignedAgent, filePath, sessionId }`

**When to use:** You're the coordinator. You've broken down work and need to assign it.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `title` | ✅ | Short task title |
| `brief` | ✅ | Detailed description (becomes task body) |
| `priority` | | `low` / `normal` / `medium` / `high` / `critical` |
| `assignedAgent` | | Agent ID from org chart. Omit to let routing rules decide. |
| `ownerTeam` | | Team ID. Auto-resolved from agent if omitted. |
| `checklist` | | Acceptance criteria (rendered as checkboxes) |
| `inputs` | | File paths or references the agent needs |
| `actor` | | Your agent ID (for audit trail) |

### `aof_task_update` — Update a task in progress

Log work, change status, mark blocked, or append outputs.

```json
{
  "taskId": "TASK-2026-02-21-001",
  "workLog": "Middleware implemented, writing tests now",
  "outputs": ["src/middleware/rate-limit.ts"],
  "actor": "swe-backend"
}
```

**Returns:** `{ success, taskId, newStatus, updatedAt }`

**When to use:** You're working on a task and need to log progress, add outputs, or change status.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `taskId` | ✅ | Task ID |
| `status` | | New status: `backlog` / `ready` / `in-progress` / `blocked` / `review` / `done` |
| `workLog` | | Progress note (appended with timestamp to Work Log section) |
| `outputs` | | Deliverable file paths (appended to Outputs section) |
| `blockedReason` | | Why the task is blocked (use with `status: "blocked"`) |
| `body` | | Replace entire task body (use sparingly) |
| `actor` | | Your agent ID |

### `aof_task_complete` — Mark task done

Completes a task with a summary and optional deliverables.

```json
{
  "taskId": "TASK-2026-02-21-001",
  "summary": "Rate limiting implemented with token-bucket algorithm. 24/24 tests passing.",
  "outputs": [
    "src/middleware/rate-limit.ts",
    "src/middleware/__tests__/rate-limit.test.ts"
  ],
  "actor": "swe-backend"
}
```

**Returns:** `{ success, taskId, finalStatus, completedAt }`

**When to use:** You've finished your assigned task and met the acceptance criteria.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `taskId` | ✅ | Task ID |
| `summary` | ✅ | What was done, key outcomes |
| `outputs` | | Final deliverable file paths |
| `skipReview` | | Skip review gate (default: false) |
| `actor` | | Your agent ID |

### `aof_status_report` — Query task status

Get counts, task lists, and summaries filtered by agent or status.

```json
{
  "agentId": "swe-backend",
  "status": "in-progress",
  "compact": true,
  "actor": "main"
}
```

**Returns:** `{ total, byStatus, tasks[], summary, details }`

**When to use:** You need to know what's in flight, what's blocked, or what a specific agent is working on.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agentId` | | Filter by agent |
| `status` | | Filter by status |
| `compact` | | Shorter output |
| `limit` | | Max tasks to return |
| `actor` | | Your agent ID |

### `aof_board` — Kanban board view

Visual board of tasks organized by status columns.

```json
{
  "team": "swe",
  "status": "in-progress",
  "priority": "high"
}
```

**Returns:** `{ team, timestamp, columns, stats }`

**When to use:** You want a high-level view of the whole pipeline — what's where, what's stuck.

---

## Agent Workflow Patterns

### Pattern 1: Coordinator dispatches work

The main/coordinator agent breaks down a request and delegates:

```
1. Call aof_status_report to see current workload
2. Call aof_dispatch for each subtask (with assignedAgent, checklist)
3. AOF scheduler routes and dispatches automatically
4. Periodically call aof_status_report to check progress
```

### Pattern 2: Worker executes assigned task

An agent receives a dispatched task and works on it:

```
1. Read the task brief and checklist
2. Do the work
3. Call aof_task_update with workLog entries as you progress
4. When done, call aof_task_complete with summary + outputs
```

### Pattern 3: Blocked task

An agent can't proceed:

```
1. Call aof_task_update with status: "blocked", blockedReason: "Need API spec from frontend team"
2. AOF notifies the coordinator
3. When unblocked, task returns to ready and gets re-dispatched
```

### Pattern 4: Dependency chains

Coordinator sets up sequential work:

```
1. aof_dispatch("Design API schema") → TASK-001
2. aof_dispatch("Implement API", inputs: ["TASK-001"]) → TASK-002
3. TASK-002 auto-blocks until TASK-001 completes
4. On TASK-001 completion, AOF cascades → TASK-002 becomes ready
```

---

## Inter-Agent Protocols

When agents communicate about tasks, use the AOF/1 protocol envelope:

```
AOF/1 {"protocol":"aof","version":1,"type":"completion.report","taskId":"TASK-001","fromAgent":"swe-backend","toAgent":"dispatcher","payload":{"outcome":"done","summary":"Implemented rate limiting"}}
```

### Protocol Types

| Type | Direction | When |
|------|-----------|------|
| `completion.report` | Worker → Dispatcher | Task done/blocked/needs review |
| `status.update` | Worker → Dispatcher | Mid-task progress |
| `handoff.request` | Coordinator → Worker | Delegating a subtask |
| `handoff.accepted` | Worker → Coordinator | Accepting delegation |
| `handoff.rejected` | Worker → Coordinator | Can't accept (with reason) |

### Completion Outcomes

| Outcome | Effect |
|---------|--------|
| `done` | Task → review → done; cascades dependencies |
| `blocked` | Task → blocked; notifies coordinator |
| `needs_review` | Task → review; awaits human/agent review |
| `partial` | Task → review; partial completion logged |

---

## Org Chart Basics

The org chart (`org/org-chart.yaml`) defines agents, teams, and routing. It's the source of truth
for the scheduler.

```yaml
schemaVersion: 1

agents:
  - id: main                    # Must match OpenClaw agent ID
    name: "Coordinator"
    canDelegate: true
    capabilities:
      tags: [coordination, delegation]
      concurrency: 3
    comms:
      preferred: send           # "send" | "spawn" | "cli"

  - id: swe-backend
    reportsTo: main
    capabilities:
      tags: [backend, typescript, api]
      concurrency: 1
    comms:
      preferred: send
      sessionKey: "agent:main:swe-backend"

teams:
  - id: swe
    name: Engineering
    lead: main

routing:
  - matchTags: [backend, api]
    targetAgent: swe-backend
    weight: 10
```

**Key:** Agent `id` values must match your OpenClaw agent names. Run `aof init` to auto-sync
from your existing OpenClaw config.

---

## Workflow Gates

Gates enforce quality checkpoints. Tasks pass through stages sequentially:

```
implement → review → qa → approve → done
```

If a reviewer rejects, the task loops back. Agents can't skip gates — the scheduler enforces order.

Gates are defined in `project.yaml` and reference roles from the org chart.

---

## Human Operator CLI Reference

**These commands are for humans, not agents.** Use for setup, debugging, and maintenance.

### Setup
```bash
aof init                          # Interactive wizard (plugin, sync, memory, skill)
aof init --yes                    # Non-interactive with defaults
aof org validate org-chart.yaml   # Validate org chart schema
aof org drift                     # Show agents in org chart vs. OpenClaw
```

**Agent sync (runs as part of `aof init`):**
- **Import:** Discovers OpenClaw agents and offers to add them to `org/org-chart.yaml`
- **Export:** Registers org chart agents missing from OpenClaw config
- **Drift check:** Shows remaining mismatches after sync
- Idempotent — safe to run repeatedly

### Monitoring
```bash
aof scan                          # All tasks by status
aof board                         # Kanban view
aof daemon status                 # Daemon health
```

### Task Management
```bash
aof task create "Title" --priority high --agent swe-backend
aof task promote TASK-<id>        # backlog → ready
aof task resurrect TASK-<id>      # Recover from dead-letter
aof lint                          # Validate all task files
```

### Scheduler
```bash
aof scheduler run                 # Dry-run: preview dispatch
aof scheduler run --active        # Live: dispatch tasks
```

---

## Notification Events

AOF emits events that trigger notifications (configured in `org/notification-rules.yaml`):

| Event | When |
|-------|------|
| `task.created` | New task |
| `task.transitioned` | Status change |
| `task.blocked` | Task blocked |
| `task.deadletter` | Task failed after max retries |
| `dependency.cascaded` | Downstream tasks auto-promoted |
| `sla.violation` | Task exceeded time limit |
| `lease.expired` | Agent heartbeat stale |

---

## Decision Table

| Situation | Action |
|-----------|--------|
| Need to assign work to another agent | `aof_dispatch` |
| Working on a task, want to log progress | `aof_task_update` with `workLog` |
| Finished a task | `aof_task_complete` with `summary` |
| Can't proceed on a task | `aof_task_update` with `status: "blocked"` |
| Need to see what's in flight | `aof_status_report` or `aof_board` |
| Need to set up AOF for first time | CLI: `aof init` (human operator) |
| Need to debug task routing | CLI: `aof org drift`, `aof scan` (human operator) |
