---
name: aof
description: >
  Work with AOF (Agentic Ops Fabric) — deterministic multi-agent orchestration with filesystem-based
  task management, org-chart governance, workflow gates, and structured inter-agent protocols.
  Use when: creating/managing agent tasks, running the scheduler, setting up org charts,
  coordinating multi-agent handoffs, monitoring system health, or configuring notifications.
  Project lives at ~/Projects/AOF/. AOF CLI manages tasks.
version: 1.0.0
requires:
  bins: [node, git]
  optional: [aof]
---

# AOF — Agentic Ops Fabric

Deterministic orchestration for multi-agent systems. Turns an agent swarm into a reliable,
observable, restart-safe operating environment. No LLMs in the control plane.

## When to Use AOF

| Scenario | AOF Feature |
|----------|------------|
| Coordinating work across multiple specialized agents | Org-chart routing + scheduler |
| Enforcing multi-stage review workflows (code → review → QA → ship) | Workflow Gates |
| Tracking tasks with dependencies and priorities | AOF task management |
| Ensuring crashed agents can recover mid-task | Run artifacts + resume protocol |
| Delegating subtasks to child agents with context | Handoff protocol |
| Broadcasting status updates during long tasks | Status update protocol |
| Getting notified when tasks complete, fail, or miss SLAs | Notification rules |
| Detecting which agents are active vs. drifted | `aof org drift` |
| Auditing task history and system events | JSONL event log |

---

## Quick Start

```bash
# Initialize AOF in a project
cd ~/Projects/AOF
./dist/cli/index.js init               # interactive
./dist/cli/index.js init --yes         # defaults

# Or via the global aof alias (if installed)
aof init
```

### OpenClaw Plugin Mode

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "aof": {
      "enabled": true,
      "config": {
        "dataDir": "~/.openclaw/aof",
        "maxConcurrentDispatches": 3
      }
    }
  }
}
```

> **Gateway URL & Token:** AOF auto-detects these from the OpenClaw runtime context
> (`api.config.gateway.port` and `api.config.gateway.auth.token`). You only need to set
> `gatewayUrl` / `gatewayToken` manually if auto-detection fails (e.g. non-standard port).
>
> **dryRun:** Defaults to `false` — the scheduler dispatches tasks live. Set `"dryRun": true`
> to observe-only mode (previews dispatch decisions without spawning agents).

Then restart the gateway: `openclaw gateway restart`

---

## CLI Reference

### Daemon

```bash
aof daemon start          # Start background daemon
aof daemon stop           # Stop daemon
aof daemon status         # Health check + active task count
aof daemon restart        # Stop + start
```

### Tasks

```bash
aof scan                  # List all tasks by status
aof task create "Title"   # Create a task
aof task create "Title" --priority high --agent swe-backend
aof task promote <id>     # Move backlog → ready
aof task resurrect <id>   # Recover from dead-letter queue
aof lint                  # Validate all task files
```

### Scheduler

```bash
aof scheduler run         # Dry-run: preview dispatch decisions
aof scheduler run --active  # Live run: dispatch tasks to agents
```

### Org Chart

```bash
aof org validate [path]   # Validate org-chart.yaml schema
aof org show [path]       # Display agents, teams, routing
aof org lint [path]       # Check referential integrity
aof org drift [path]      # Detect drift vs. active OpenClaw agents
```

### Memory

```bash
aof memory generate       # Generate memory config from org chart
aof memory audit          # Audit memory config vs. org chart
aof memory curate         # Generate curation tasks (adaptive thresholds)
```

### Observability

```bash
aof board                 # Kanban view of all tasks
aof watch <viewType>      # Live-watch a view directory
aof metrics serve         # Start Prometheus metrics endpoint
```

---

## Task Management

AOF uses its own filesystem-based task tracking. Tasks are Markdown files dispatched to agents by the scheduler.

### Core Commands

```bash
# Create tasks
aof task create "Implement JWT auth" --agent swe-backend --priority high
aof task create "Quick capture title"          # defaults: normal priority, _inbox project

# Navigate tasks
aof scan                                       # All tasks by status
aof scan --status ready                        # Filter by status
aof board                                      # Kanban view

# Manage tasks
aof task promote TASK-<id>                     # backlog → ready
aof task block TASK-<id> "Reason"              # Mark blocked
aof task unblock TASK-<id>                     # Unblock
aof task close TASK-<id>                       # Mark done

# Dependencies
aof task dep add TASK-child TASK-blocker       # child depends on blocker
aof task dep remove TASK-child TASK-blocker    # remove dependency
aof scan --status ready                        # tasks with no open blockers
```

### Task Lifecycle

```
backlog → ready → in-progress → review → done
                      ↓
                   blocked → (resurface) → ready
                      ↓
                  dead-letter (use aof task resurrect)
```

### Task File Format (Markdown + YAML Frontmatter)

Tasks are plain `.md` files in `tasks/<status>/` directories:

```markdown
---
schemaVersion: 1
id: TASK-2026-02-21-001
title: Add rate limiting to API gateway
status: ready
priority: high
routing:
  role: swe-backend
  team: swe
  tags: [security, api, performance]
createdAt: 2026-02-21T09:00:00Z
updatedAt: 2026-02-21T09:00:00Z
createdBy: swe-architect
dependsOn: [TASK-2026-02-20-003]
metadata:
  phase: 2
  epic: platform-hardening
---

# Objective
Add token-bucket rate limiting middleware to the API gateway.

## Acceptance Criteria
- [ ] 429 responses for requests exceeding 100 req/min per token
- [ ] Rate limit config in org-chart (not hardcoded)
- [ ] Tests pass (≥ 95% coverage)
- [ ] No regressions in existing API tests
```

State transitions use atomic filesystem `rename()` — no database, no locks beyond the lease.

---

## Org Chart (`org/org-chart.yaml`)

The org chart is the **source of truth** for agents, teams, routing, and memory scopes.

### Minimal Org Chart

```yaml
schemaVersion: 1
template: "minimal"

agents:
  - id: main
    name: "Coordinator"
    description: "Central coordinator and strategist"
    team: ops
    canDelegate: true
    active: true
    capabilities:
      tags: ["coordination", "delegation"]
      concurrency: 3
      model: "anthropic/claude-opus-4-6"
      provider: "anthropic"
    comms:
      preferred: "send"

  - id: swe-backend
    name: "Backend Engineer"
    description: "Implements APIs and data layer"
    team: swe
    reportsTo: "main"
    active: true
    capabilities:
      tags: ["backend", "typescript", "api"]
      concurrency: 1
      model: "anthropic-api/claude-sonnet-4-5"
      provider: "anthropic-api"
    comms:
      preferred: "send"
      sessionKey: "agent:swe-backend:main"

teams:
  - id: ops
    name: "Operations"
    lead: "main"
  - id: swe
    name: "Engineering"
    lead: "main"

routing:
  - matchTags: ["backend", "api", "typescript"]
    targetAgent: "swe-backend"
    weight: 10
```

### Full Org Chart with Memory Pools + Watchdog

```yaml
schemaVersion: 1
template: "openclaw-full"

memoryPools:
  hot:
    path: "Resources/OpenClaw/_Core"
    description: "Always-indexed operator context"
  warm:
    - id: architecture
      path: "Resources/OpenClaw/Architecture"
      description: "Architecture decision records"
      roles: [main, swe-architect, swe-*]
    - id: runbooks
      path: "Resources/OpenClaw/Runbooks"
      description: "Operational runbooks"
      roles: [main, openclaw-custodian]
  cold:
    - Logs
    - Approvals
    - _archived

agents:
  - id: swe-architect
    name: "SWE Architect"
    description: "System design and orchestration"
    team: swe
    reportsTo: "main"
    canDelegate: true
    active: true
    capabilities:
      tags: ["architecture", "design", "delegation"]
      concurrency: 2
      model: "openai-api/gpt-4o"
      provider: "openai-api"
    comms:
      preferred: "send"
      sessionKey: "agent:swe-architect:main"

  - id: swe-qa
    name: "SWE QA"
    description: "Quality assurance and testing"
    team: swe
    reportsTo: "swe-architect"
    active: true
    capabilities:
      tags: ["testing", "qa", "bdd"]
      concurrency: 1
      model: "anthropic-api/claude-sonnet-4-5"
      provider: "anthropic-api"

teams:
  - id: swe
    name: "Software Engineering"
    description: "Build and maintain systems"
    lead: "swe-architect"

routing:
  - matchTags: ["security", "audit"]
    targetAgent: "swe-security"
    weight: 20
  - matchTags: ["testing", "qa"]
    targetAgent: "swe-qa"
    weight: 15
  - matchTags: ["backend", "api"]
    targetAgent: "swe-backend"
    weight: 10

aof:
  daemon:
    watchdog:
      enabled: true
      pollIntervalMs: 60000
      restartPolicy:
        maxRestarts: 3
        windowMs: 3600000
      alerting:
        channel: slack
        webhook: "https://hooks.slack.com/services/..."
```

---

## Workflow Gates

Gates enforce multi-stage review checkpoints. Defined in `project.yaml`:

```yaml
workflow:
  name: standard-feature
  rejectionStrategy: origin        # rejected tasks return to the gate that submitted them
  gates:
    - id: implement
      role: developer
      description: "Build feature with tests"

    - id: review
      role: reviewer
      canReject: true              # reviewer can send back for revision
      description: "Architecture + code quality review"

    - id: qa
      role: qa-engineer
      canReject: true
      description: "Functional and regression testing"

    - id: approve
      role: product-owner
      canReject: true
      conditional: "task.metadata.needsApproval == true"   # skip if flag not set
      description: "Final sign-off"

  outcomes:
    complete: advance              # done → advance to next gate
    needs_review: reject           # needs_review → loop back
```

**Gate transitions:** task.status stays `in-progress` as it moves through gates; the `gate` field tracks current position.

---

## Inter-Agent Protocols

Structured messages for agent-to-agent coordination. All messages use the AOF/1 envelope.

### Protocol Envelope

```json
{
  "protocol": "aof",
  "version": 1,
  "type": "completion.report",
  "taskId": "TASK-2026-02-21-001",
  "fromAgent": "swe-backend",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-21T10:00:00.000Z",
  "payload": { "...": "type-specific" }
}
```

With `AOF/1` prefix (for plain-text channels):
```
AOF/1 {"protocol":"aof","version":1,"type":"completion.report",...}
```

### Completion Report (task done / blocked / needs review)

```json
{
  "protocol": "aof", "version": 1,
  "type": "completion.report",
  "taskId": "TASK-2026-02-21-001",
  "fromAgent": "swe-backend",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-21T10:00:00.000Z",
  "payload": {
    "outcome": "done",
    "summaryRef": "outputs/summary.md",
    "deliverables": ["src/middleware/rate-limit.ts", "src/middleware/__tests__/rate-limit.test.ts"],
    "tests": { "total": 24, "passed": 24, "failed": 0 },
    "notes": "Implemented token-bucket; config loaded from org-chart"
  }
}
```

**Outcomes:**
- `done` — completed; transitions `in-progress → review → done`
- `blocked` — cannot proceed; transitions to `blocked` (include `blockers` array)
- `needs_review` — human review required; transitions to `review`
- `partial` — partially complete; transitions to `review`

### Status Update (mid-task progress)

```json
{
  "protocol": "aof", "version": 1,
  "type": "status.update",
  "taskId": "TASK-2026-02-21-001",
  "fromAgent": "swe-backend",
  "toAgent": "dispatcher",
  "sentAt": "2026-02-21T09:30:00.000Z",
  "payload": {
    "progress": 60,
    "summary": "Middleware implemented; writing tests now",
    "eta": "2026-02-21T11:00:00.000Z"
  }
}
```

### Handoff Request (delegation to child agent)

```json
{
  "protocol": "aof", "version": 1,
  "type": "handoff.request",
  "taskId": "TASK-2026-02-21-001",
  "fromAgent": "swe-architect",
  "toAgent": "swe-backend",
  "sentAt": "2026-02-21T09:00:00.000Z",
  "payload": {
    "childTaskId": "TASK-2026-02-21-002",
    "context": "Implement token-bucket rate limiting. See outputs/spec.md.",
    "acceptanceCriteria": [
      "429 for >100 req/min per token",
      "Config in org-chart",
      "Tests ≥ 95% coverage"
    ],
    "inputs": ["outputs/spec.md", "outputs/api-contract.yaml"]
  }
}
```

Child agent responds:

```json
{
  "type": "handoff.accepted",
  "taskId": "TASK-2026-02-21-002",
  "fromAgent": "swe-backend",
  "toAgent": "swe-architect",
  ...
}
```

Or rejects (moves child to `blocked`):

```json
{
  "type": "handoff.rejected",
  "payload": { "reason": "Missing API contract for downstream service X" }
}
```

### Resume Protocol (crash recovery)

When the scheduler detects a stale heartbeat on a task, it consults `run_result.json`. If present, it applies the recorded outcome. If absent, it reclaims the task back to `ready` for re-dispatch.

Agents write `run_result.json` before they finish:
```json
{
  "outcome": "done",
  "summaryRef": "outputs/summary.md",
  "completedAt": "2026-02-21T10:00:00.000Z"
}
```

This ensures **idempotent recovery** — re-dispatched agents pick up where they left off.

---

## Notification System

Configure in `org/notification-rules.yaml`. Rules are **first-match-wins**.

### Severity Tiers

| Tier | When | Dedupe Window |
|------|------|--------------|
| `info` | Routine lifecycle (task started, completed) | 5 min |
| `warn` | Attention needed (blocked, SLA breach, lease expired) | 5–15 min |
| `critical` | Urgent, never suppressed (dead-letter, gate escalation) | None (`neverSuppress: true`) |

### Rule Structure

```yaml
version: 1

defaults:
  dedupeWindowMs: 300000        # 5 minutes global default
  criticalNeverSuppressed: true

rules:
  # Specific payload matchers BEFORE generic eventType rules
  - match:
      eventType: "task.transitioned"
      payload:
        to: "review"
    severity: warn
    audience: [team-lead, operator]
    channel: "#eng-review"
    template: "👀 {taskId} ready for review (by {actor})"
    dedupeWindowMs: 0           # Always send — review is urgent

  - match:
      eventType: "task.deadletter"
    severity: critical
    audience: [operator]
    channel: "#eng-alerts"
    template: "🪦 Task {taskId} dead-lettered: {payload.reason}"
    neverSuppress: true

  - match:
      eventType: "sla.violation"
    severity: warn
    audience: [team-lead]
    channel: "#eng-alerts"
    template: "⚠️ SLA breach: {taskId} in-progress {payload.durationHrs}h (limit: {payload.limitHrs}h)"
    dedupeWindowMs: 900000      # 15 min — matches SlaChecker rate
```

### Key Event Types

| Event | Fired When |
|-------|-----------|
| `task.created` | New task created |
| `task.transitioned` | Status change (payload: `from`, `to`) |
| `task.blocked` | Task marked blocked |
| `task.deadletter` | Task moved to dead-letter queue |
| `task.resurrected` | Dead-letter task recovered |
| `dependency.cascaded` | Downstream tasks auto-promoted/blocked |
| `sla.violation` | Task exceeds SLA time limit |
| `lease.expired` | Agent heartbeat stale, lease reclaimed |
| `gate_timeout` | Gate checkpoint stalled |
| `gate_timeout_escalation` | Gate escalated after SLA breach |
| `system.drift-detected` | Org chart vs. active agents out of sync |
| `system.startup` / `system.shutdown` | Daemon lifecycle |

---

## Common Workflows

### 1. Create and Dispatch a Task

```bash
# Create task (lands in backlog)
aof task create "Add OAuth2 support" \
  --agent swe-backend \
  --priority high

# Promote from backlog to ready
aof task promote TASK-<id>

# Run scheduler to dispatch
aof scheduler run --active
```

### 2. Check System Status

```bash
aof board                        # Kanban view
aof daemon status                # Daemon health + concurrency
aof scan                         # All tasks by status
aof org drift                    # Active agents vs. org chart
```

### 3. Handle a Blocked Task

```bash
cat tasks/blocked/TASK-<id>.md   # See why it's blocked
aof task unblock TASK-<id>       # Unblock (after resolving the blocker)
aof scheduler run --active       # Redispatch
```

### 4. Resurrect a Dead-Lettered Task

```bash
aof task resurrect TASK-2026-02-21-001
# → moves task from dead-letter back to backlog
aof task promote TASK-2026-02-21-001
# → backlog → ready → dispatcher picks it up on next run
```

### 5. Validate Org Chart Changes

```bash
aof org validate org/org-chart.yaml
aof org lint org/org-chart.yaml
aof org drift org/org-chart.yaml
```

### 6. Dependency Chain Orchestration

```bash
# Create tasks with blocking dependencies
aof task create "Design API schema"           # → TASK-2026-02-21-001
aof task create "Implement API"               # → TASK-2026-02-21-002
aof task create "Write API docs"              # → TASK-2026-02-21-003

# Set up dependency chain: 002 waits on 001, 003 waits on 002
aof task dep add TASK-2026-02-21-002 TASK-2026-02-21-001
aof task dep add TASK-2026-02-21-003 TASK-2026-02-21-002

# Promote all to ready; scheduler dispatches only TASK-001 (others blocked)
aof task promote TASK-2026-02-21-001
aof task promote TASK-2026-02-21-002
aof task promote TASK-2026-02-21-003
aof scan --status ready
```

---

## Project Structure

```
~/Projects/AOF/
├── src/
│   ├── cli/commands/     # CLI command handlers (one file per command)
│   ├── dispatch/         # Scheduler, executor, gate evaluator, SLA checker
│   ├── store/            # Filesystem task storage + lease management
│   ├── protocol/         # Protocol router, parsers, formatters
│   ├── events/           # JSONL event logger + notification service
│   ├── org/              # Org-chart parser and validator
│   ├── memory/           # Memory medallion pipeline
│   └── schemas/          # Zod schemas (source of truth for all data shapes)
├── tasks/
│   ├── backlog/          # Created but not scheduled
│   ├── ready/            # Waiting for dispatch
│   ├── in-progress/      # Claimed by an agent (has lease)
│   ├── review/           # Awaiting human or agent review
│   ├── blocked/          # Waiting on external dependency
│   ├── done/             # Completed
│   └── dead-letter/      # Failed after max retries
├── org/
│   ├── org-chart.yaml    # Agent/team/routing definitions
│   └── notification-rules.yaml
├── events/               # JSONL event log (append-only)
├── views/                # Generated kanban + mailbox views
└── docs/                 # Design docs, protocol specs, runbooks
```

---

## Key Design Principles

- **No LLMs in the control plane** — all scheduling and routing is deterministic
- **Filesystem as API** — state transitions use atomic `rename()`, no database required
- **Crash-safe by default** — every dispatch writes `run.json` + heartbeat; recovery is automatic
- **Org-chart driven** — agents, routing, memory scopes, and policies all defined in YAML
- **Idempotent protocols** — sending the same completion report twice is safe
- **Schema-first** — Zod schemas are the source of truth; TypeScript types are derived

## See Also

- `docs/PROTOCOLS-USER-GUIDE.md` — full protocol reference
- `docs/WORKFLOW-GATES.md` — gate system deep-dive
- `docs/notification-policy.md` — notification system internals
- `docs/SLA-GUIDE.md` — SLA configuration reference
- `docs/RECOVERY-RUNBOOK.md` — recovery procedures
