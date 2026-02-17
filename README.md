# AOF — Agentic Ops Fabric

Deterministic orchestration layer for multi-agent systems. Turns an agent swarm into a reliable, observable, restart-safe operating system for agent work.

## Features

- **Filesystem-as-API**: Tasks are Markdown files with YAML frontmatter. State transitions use atomic `rename()`.
- **Deterministic dispatch**: Scheduler runs without LLM in control plane. Lease-based locking, adaptive concurrency, workflow gates.
- **Org-chart governance**: Declarative YAML defines teams, agents, routing rules, memory scopes, and curation policies.
- **Memory medallion pipeline**: Hot/warm/cold tiers with org-chart-driven scoping. AOF manages lifecycle; host platform handles retrieval.
- **Observability**: Prometheus metrics endpoint, JSONL event log, real-time Kanban and mailbox views.
- **Recovery-first**: SLA enforcement, deadletter queue, task resurrection, drift detection.

## Quick Start

### Installation

```bash
git clone https://github.com/xavierspriet/aof.git ~/Projects/AOF
cd ~/Projects/AOF
npm install
npm run build
```

### Initialize

```bash
# Create AOF installation (interactive)
./dist/cli/index.js init

# Or use defaults (non-interactive)
./dist/cli/index.js init --yes --template minimal
```

### Basic Usage

```bash
# List all tasks
aof scan

# Run scheduler (dry-run)
aof scheduler run

# Run scheduler (active)
aof scheduler run --active

# Create a task
aof task create "Fix memory leak in dispatcher" --priority high --agent swe-backend

# Start daemon
aof daemon start

# Check daemon status
aof daemon status
```

### OpenClaw Plugin Mode

AOF can run as an OpenClaw plugin:

```bash
# Integrate with OpenClaw
aof integrate openclaw

# Restart gateway to load plugin
openclaw gateway restart
```

Plugin config (`~/.openclaw/openclaw.json`):

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

## Architecture

### Core Modules

- **cli**: Command-line interface (Commander.js)
- **daemon**: Background service with HTTP health endpoint
- **dispatch**: Scheduler, executor, SLA checker, gate evaluator, failure tracker, deadletter
- **store**: Filesystem-based task storage (atomic rename for state transitions)
- **events**: JSONL event logger
- **memory**: Curation generator, medallion pipeline (hot → warm → cold)
- **metrics**: Prometheus exporter
- **org**: Org-chart parser and validator
- **schemas**: Zod schemas for task, gate, workflow, SLA, deadletter, org-chart
- **views**: Kanban and mailbox view generators
- **recovery**: Task resurrection, lease expiration, deadletter handling

### Task Lifecycle

```
backlog → ready → in-progress → review → done
                      ↓
                   blocked
                      ↓
                  deadletter (resurrectable)
```

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
metadata:
  phase: 1
---

# Objective
Fix memory leak in scheduler poll loop.

## Acceptance Criteria
- [ ] Memory usage stable over 1000 poll cycles
- [ ] No leaked timers or event listeners
- [ ] Tests pass
```

State transitions happen via atomic filesystem operations:

```
tasks/ready/TASK-2026-02-17-001.md
  → tasks/in-progress/TASK-2026-02-17-001.md
  → tasks/done/TASK-2026-02-17-001.md
```

## CLI Reference

### Daemon

- `aof daemon start` - Start background daemon
- `aof daemon stop` - Stop daemon
- `aof daemon status` - Check daemon status
- `aof daemon restart` - Restart daemon

### Tasks

- `aof scan` - List all tasks by status
- `aof task create <title>` - Create new task
- `aof task resurrect <id>` - Resurrect deadlettered task
- `aof task promote <id>` - Promote task from backlog to ready

### Scheduler

- `aof scheduler run` - Run one poll cycle (dry-run)
- `aof scheduler run --active` - Run one poll cycle (mutate state)

### Org Chart

- `aof org validate [path]` - Validate schema
- `aof org show [path]` - Display org chart
- `aof org lint [path]` - Check referential integrity
- `aof org drift [path]` - Detect drift vs. OpenClaw agents

### Memory

- `aof memory generate` - Generate OpenClaw memory config from org chart
- `aof memory audit` - Audit memory config vs. org chart
- `aof memory curate` - Generate curation tasks based on adaptive thresholds

### Observability

- `aof board` - Display Kanban board
- `aof watch <viewType>` - Watch view directory for real-time updates
- `aof metrics serve` - Start Prometheus metrics server
- `aof lint` - Lint all task files

## Configuration

### Org Chart (`org/org-chart.yaml`)

Defines agents, teams, routing rules, and memory pools:

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

### Workflow Gates

Gates block task dispatch until conditions are met:

```yaml
gates:
  - id: all-tests-pass
    type: shell
    command: npm test
  - id: pr-approved
    type: manual
    approver: swe-lead
```

### SLA Configuration

```yaml
slas:
  - priority: critical
    maxAge: 3600000  # 1 hour
    action: escalate
```

## Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm test -- --testPathPattern="src/.*/.*\\.test\\.ts$"

# Run e2e tests
npm run test:e2e

# Watch mode
npm run test:watch
```

Test suite: 164 test files, ~1308 tests total.

## Project Structure

```
~/Projects/AOF/
├── src/              # TypeScript source
├── dist/             # Compiled output
├── tasks/            # Task files (backlog, ready, in-progress, etc.)
├── org/              # Org chart and config
├── events/           # JSONL event log
├── views/            # Kanban and mailbox views
├── memory/           # Memory tier directories
├── docs/             # Documentation
├── tests/            # Test suites
└── scripts/          # Build and deployment scripts
```

## License

MIT
