# AOF — Agentic Ops Fabric

**Deterministic orchestration for multi-agent systems.** AOF turns an agent swarm into a reliable, observable, restart-safe operating environment — with enforced workflows, cascading dependencies, and structured inter-agent communication.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-2195%20passing-brightgreen)](#testing)

---

## Why AOF?

Multi-agent systems have a coordination problem. Agents run in parallel, share state, drop work on failure, and have no built-in mechanism to enforce quality gates or process stages.

AOF solves this with a filesystem-first control plane:

- **Tasks are Markdown files** — human-readable, diff-able, tool-agnostic
- **State transitions are atomic `rename()` calls** — no database, no race conditions
- **The scheduler runs without LLM involvement** — deterministic, testable, cheap
- **Workflow gates block dispatch** until conditions are met — agents can't skip reviews
- **Protocol system** gives agents structured, crash-safe inter-agent communication

---

## Key Features

| Feature | Description |
|---|---|
| **Org-chart governance** | Declarative YAML defines agents, teams, routing rules, memory scopes |
| **SDLC workflow enforcement** | Multi-stage gates (implement → review → QA → approve) with rejection loops |
| **Deterministic scheduling** | Lease-based locking, adaptive concurrency, SLA enforcement |
| **Protocol system** | Structured handoff, resume, status-update, and completion messages |
| **Cascading dependencies** | Task completion/blocking immediately propagates to dependents |
| **Notification engine** | Channel routing, deduplication, storm batching for busy periods |
| **HNSW vector search** | Cosine-similarity memory search with incremental inserts and disk persistence |
| **Recovery-first** | Deadletter queue, task resurrection, lease expiration, drift detection |
| **Observability** | Prometheus metrics, JSONL event log, real-time Kanban and mailbox views |

---

## Quick Start

### Prerequisites

- Node.js 20+
- npm 9+

### Install

```bash
git clone https://github.com/demerzel-ops/aof.git
cd aof
npm install
npm run build
```

### Initialize a project

```bash
# Interactive setup
node dist/cli/index.js init

# Non-interactive with defaults
node dist/cli/index.js init --yes --template minimal
```

### Basic usage

```bash
# Alias for convenience (optional)
alias aof="node $(pwd)/dist/cli/index.js"

# Create a task
aof task create "Implement login endpoint" --priority high --agent swe-backend

# See all tasks
aof scan

# Run one scheduler cycle (dry-run — no state changes)
aof scheduler run

# Run scheduler (active mode — dispatches work)
aof scheduler run --active

# Show Kanban board
aof board
```

### Run as a daemon

```bash
aof daemon start
aof daemon status
aof daemon stop
```

### OpenClaw plugin mode

AOF integrates directly with [OpenClaw](https://openclaw.dev) as a plugin:

```bash
aof integrate openclaw
openclaw gateway restart
```

Plugin configuration (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "aof": {
      "enabled": true,
      "config": {
        "dryRun": false,
        "dataDir": "~/.openclaw/aof",
        "gatewayUrl": "http://127.0.0.1:18789",
        "gatewayToken": "your-token-here",
        "maxConcurrentDispatches": 3
      }
    }
  }
}
```

---

## Architecture

AOF is organized into focused modules:

```
src/
├── cli/          Command-line interface (Commander.js)
├── daemon/       Background service with HTTP health endpoint
├── dispatch/     Scheduler, gate evaluator, SLA checker, lease manager, dep-cascader
├── store/        Filesystem task store (atomic rename for state transitions)
├── protocol/     Inter-agent protocol router (handoff, resume, status update, completion)
├── events/       JSONL event logger + notification engine
├── memory/       Medallion pipeline (hot → warm → cold) + HNSW vector index
├── metrics/      Prometheus exporter
├── org/          Org-chart parser and validator
├── schemas/      Zod schemas for tasks, gates, workflows, SLA, org-chart
├── views/        Kanban and mailbox view generators
└── recovery/     Task resurrection, lease expiration, deadletter handling
```

### Task lifecycle

```
backlog → ready → in-progress → review → done
                       │
                   blocked ──► deadletter (resurrectable)
```

State transitions use atomic filesystem `rename()` — no database, no locks beyond the OS.

### Workflow gates

Gates enforce multi-stage processes:

```
in-progress [implement gate]
     ↓  (agent signals completion)
review     [review gate — routed to reviewer role]
     ↓  (reviewer approves)   ↘ (reviewer rejects → loops back)
done
```

See [docs/WORKFLOW-GATES.md](docs/WORKFLOW-GATES.md) for full reference.

### Protocol system

Agents communicate via typed protocol envelopes — not free-form messages:

- `completion.report` — task done/blocked/needs_review/partial
- `status.update` — mid-task progress, work log entries
- `handoff.request` / `handoff.accepted` / `handoff.rejected` — task delegation
- `resume` — deterministic re-entry after interruption

See [docs/PROTOCOLS-USER-GUIDE.md](docs/PROTOCOLS-USER-GUIDE.md) for examples.

---

## Task Format

Tasks are Markdown files with YAML frontmatter:

```markdown
---
schemaVersion: 1
id: TASK-2026-02-17-001
title: Fix scheduler memory leak
status: ready
priority: high
routing:
  role: swe-backend
  team: swe-suite
  tags: [bug, performance]
createdAt: 2026-02-17T09:00:00Z
updatedAt: 2026-02-17T09:00:00Z
createdBy: swe-architect
dependsOn: []
---

# Objective
Fix memory leak in scheduler poll loop.

## Acceptance Criteria
- [ ] Memory usage stable over 1000 poll cycles
- [ ] No leaked timers or event listeners
- [ ] Tests pass
```

Full schema reference: [docs/task-format.md](docs/task-format.md)

---

## Configuration

### Org chart (`org/org-chart.yaml`)

```yaml
version: 1
agents:
  - id: swe-backend
    name: Backend Engineer
    capabilities: [typescript, nodejs, apis]
teams:
  - id: swe-suite
    name: Software Engineering
    members: [swe-backend, swe-frontend]
memoryPools:
  hot:
    path: memory/hot
  warm:
    - id: per-agent
      path: memory/warm/agents
```

### Workflow gates

```yaml
gates:
  - id: review
    role: swe-lead
    canReject: true
  - id: qa
    role: swe-qa
    type: shell
    command: npm test
```

### SLA configuration

```yaml
slas:
  - priority: critical
    maxAge: 3600000   # 1 hour in ms
    action: escalate
```

---

## CLI Reference

### Daemon
| Command | Description |
|---|---|
| `aof daemon start` | Start background daemon |
| `aof daemon stop` | Stop daemon |
| `aof daemon status` | Check daemon status |
| `aof daemon restart` | Restart daemon |

### Tasks
| Command | Description |
|---|---|
| `aof scan` | List all tasks by status |
| `aof task create <title>` | Create a new task |
| `aof task resurrect <id>` | Resurrect a deadlettered task |
| `aof task promote <id>` | Promote task from backlog to ready |

### Scheduler
| Command | Description |
|---|---|
| `aof scheduler run` | One poll cycle (dry-run) |
| `aof scheduler run --active` | One poll cycle (mutate state) |

### Org chart
| Command | Description |
|---|---|
| `aof org validate [path]` | Validate schema |
| `aof org show [path]` | Display org chart |
| `aof org lint [path]` | Check referential integrity |
| `aof org drift [path]` | Detect drift vs. active agents |

### Memory
| Command | Description |
|---|---|
| `aof memory generate` | Generate memory config from org chart |
| `aof memory audit` | Audit memory config vs. org chart |
| `aof memory curate` | Generate curation tasks |

### Observability
| Command | Description |
|---|---|
| `aof board` | Display Kanban board |
| `aof watch <viewType>` | Watch view directory (real-time) |
| `aof metrics serve` | Start Prometheus metrics server |
| `aof lint` | Lint all task files |

---

## Testing

```bash
# Run full test suite (2,195 tests)
npm test

# Run targeted tests
npx vitest run src/dispatch

# Watch mode
npm run test:watch
```

---

## Project Structure

```
aof/
├── src/              TypeScript source
├── dist/             Compiled output
├── tests/            Integration and e2e test suites
├── tasks/            Task files (backlog/, ready/, in-progress/, etc.)
├── org/              Org chart YAML and config
├── events/           JSONL event log
├── views/            Kanban and mailbox view files
├── memory/           Memory tier directories
├── docs/             Documentation
└── scripts/          Build and deployment scripts
```

---

## Documentation

| Document | Description |
|---|---|
| [docs/WORKFLOW-GATES.md](docs/WORKFLOW-GATES.md) | Workflow gate configuration and examples |
| [docs/PROTOCOLS-USER-GUIDE.md](docs/PROTOCOLS-USER-GUIDE.md) | Inter-agent protocol reference |
| [docs/task-format.md](docs/task-format.md) | Full task frontmatter schema |
| [docs/SLA-GUIDE.md](docs/SLA-GUIDE.md) | SLA configuration and enforcement |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment guide |
| [docs/notification-policy.md](docs/notification-policy.md) | Notification engine configuration |
| [docs/RECOVERY-RUNBOOK.md](docs/RECOVERY-RUNBOOK.md) | Recovery procedures |
| [docs/memory-medallion-pipeline.md](docs/memory-medallion-pipeline.md) | Memory tier architecture |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and the pull request process.

---

## License

MIT — see [LICENSE](LICENSE).
