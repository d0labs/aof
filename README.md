# AOF -- Agentic Ops Fabric

**Tasks never get dropped.** AOF is a deterministic orchestration layer for multi-agent systems -- tasks survive gateway restarts, API failures, rate limits, and agent crashes, always resuming and completing end-to-end without human intervention.

---

## What It Does

- **Task orchestration** -- Filesystem-first kanban with atomic state transitions, lease-based locking, and cascading dependencies
- **Multi-agent dispatch** -- Org chart governance, capability-based routing, and adaptive concurrency control
- **Workflow gates** -- Enforce multi-stage processes (implement, review, QA, deploy) with rejection loops
- **Semantic memory** -- HNSW vector search with tiered hot/warm/cold memory pools and hybrid BM25+vector retrieval
- **Event sourcing** -- Append-only JSONL event log feeding Prometheus metrics, notifications, and audit trails

---

## Quick Start

### Prerequisites

- **Node.js >= 22** (LTS recommended)
- **OpenClaw gateway** running ([openclaw.dev](https://openclaw.dev))

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

### Set up and run

```bash
aof init              # Configure OpenClaw integration
aof daemon install    # Start the background daemon
aof task create "My first task" --agent main-agent
aof daemon status     # Verify it's running
```

See the **[Getting Started Guide](docs/guide/getting-started.md)** for a complete zero-to-working walkthrough.

---

## Key Features

| Feature | Description | Docs |
|---------|-------------|------|
| Org chart governance | Declarative YAML defines agents, teams, routing rules, memory scopes | [Configuration](docs/guide/configuration.md) |
| Workflow gates | Multi-stage review gates with rejection loops | [Workflow Gates](docs/guide/workflow-gates.md) |
| Protocol system | Typed inter-agent messages: handoff, resume, status update, completion | [Protocols](docs/guide/protocols.md) |
| Semantic memory | HNSW vector index with hybrid search and tiered curation | [Memory](docs/guide/memory.md) |
| Recovery-first | Deadletter queue, task resurrection, lease expiration, drift detection | [Recovery](docs/guide/recovery.md) |
| Observability | Prometheus metrics, JSONL events, Kanban board, real-time views | [Event Logs](docs/guide/event-logs.md) |

---

## Documentation

### For Users

- **[Getting Started](docs/guide/getting-started.md)** -- Install, configure, dispatch your first task
- **[Configuration Reference](docs/guide/configuration.md)** -- Org chart schema, AOF config, OpenClaw plugin wiring
- **[CLI Reference](docs/guide/cli-reference.md)** -- Complete command reference (auto-generated)
- **[Full User Guide](docs/README.md)** -- All user-facing docs

### For Contributors

- **[Architecture Overview](docs/dev/architecture.md)** -- System diagram, subsystem descriptions, key interfaces
- **[Dev Workflow](docs/dev/dev-workflow.md)** -- Development setup and fast-feedback loop
- **[Full Developer Guide](docs/README.md)** -- All contributor and design docs

---

## License

MIT -- see [LICENSE](LICENSE).
