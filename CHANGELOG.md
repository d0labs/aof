# Changelog

All notable changes to AOF are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)  
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [0.1.0] — 2026-02-21

Initial public release. Layers 1 and 2 are production-stable with 2,195 passing tests across 134 closed milestones.

### Core Platform (Layer 1)

**Filesystem-based task store**
- Tasks are Markdown files with YAML frontmatter in typed status directories (`backlog/`, `ready/`, `in-progress/`, `review/`, `done/`, `blocked/`, `deadletter/`)
- State transitions use atomic `rename()` — no database, no locks beyond the OS
- Full Zod schema validation on read and write

**Deterministic scheduler**
- Lease-based concurrency control — agents hold time-bounded leases on tasks
- Adaptive concurrency limits based on system load
- O(n) circular dependency detection (fixed from O(n²))
- SLA enforcement with configurable escalation thresholds
- Dry-run mode for safe inspection

**Org-chart governance**
- Declarative YAML defines agents, teams, routing rules, and memory scopes
- `aof org validate` / `aof org lint` / `aof org drift` for org-chart management
- Drift detection compares declared org against active agent roster

**Recovery system**
- Deadletter queue with task resurrection (`aof task resurrect`)
- Lease expiration detection and cleanup
- Stall detection and automatic escalation
- `retryCount` resets correctly on unblock and resurrect

### SDLC Workflow Enforcement (Layer 1)

**Workflow gates**
- Multi-stage process enforcement: implement → review → QA → approve
- Gate routing: tasks dispatched only to agents with the required role at each gate
- Rejection loops: reviewers can send work back with structured feedback
- Conditional gates: gates activate based on task metadata (e.g., security review only for auth changes)
- Shell gates: gate conditions evaluated via subprocess commands
- SLA tracking per gate with automatic escalation on timeout
- Full audit trail: every gate transition logged with actor and timestamp

**SDLC integration tests**
- End-to-end test covering multi-agent SDLC lifecycle: implement → review → QA → release approval
- Proves deterministic dispatch without LLM involvement

### Protocol System (Layer 2)

Structured inter-agent communication via typed protocol envelopes. All messages validated against Zod schemas before processing.

**Message types**
- `completion.report` — agents signal task outcome (done / blocked / needs_review / partial)
- `status.update` — mid-task progress updates and work log entries
- `handoff.request` / `handoff.accepted` / `handoff.rejected` — task delegation with structured acceptance criteria
- `resume` — deterministic re-entry after interruption or handoff

**Safety features**
- Per-task mutex lock manager prevents concurrent protocol message processing
- Payload size validation guards against oversized messages (SEC-003)
- Authorization check: only the assigned agent (or admin) can mutate task state
- Crash-safe run artifacts written atomically for resume support

**Cascading dependencies**
- `cascadeOnCompletion`: when a task completes, dependents whose remaining deps are all satisfied are immediately promoted to `ready` — no waiting for the next scheduler poll
- `cascadeOnBlock`: when a task is blocked, direct dependents that required it are transitively blocked (opt-in via `cascadeBlocks` config flag)
- `dependency.cascaded` event emitted summarizing each cascade operation

### Notification Engine (Layer 2)

**Policy-based routing**
- YAML rules map event types to notification channels and severity levels
- Configurable deduplications window (default 5 minutes) per `(taskId, eventType)` pair — critical alerts never suppressed
- Storm batcher: high-frequency events are grouped before delivery to prevent notification floods
- Hot-reload: notification config changes apply without daemon restart

**Channel routing**
- Built-in channel map: `#aof-dispatch`, `#aof-alerts`, `#aof-critical`
- Adapter interface for custom channel implementations (Matrix, Slack, console, etc.)
- `aof notifications test` CLI command for integration verification

### Memory System (Layer 2)

**Medallion pipeline**
- Hot / warm / cold tier architecture with org-chart-driven scoping
- Per-agent and per-team memory pools
- Adaptive threshold-based curation (`aof memory curate`)

**HNSW vector search**
- Cosine-similarity k-NN search via `hnswlib-node`
- Incremental inserts with automatic capacity growth (no full rebuild)
- `markDelete`-based removal — deleted vectors excluded from results without index rebuild
- Disk persistence (save/load) — index survives restarts
- Labels map 1-to-1 to SQLite chunk IDs for hybrid search

**Hybrid search engine**
- Combines HNSW vector search with FTS5 full-text search (SQLite)
- `memory_search`, `memory_store`, `memory_get`, `memory_update`, `memory_delete`, `memory_list` MCP tools

**Index sync**
- `IndexSyncService`: incrementally indexes files as they change (file hash tracker prevents redundant re-indexing)

### Observability

- Prometheus metrics endpoint (`aof metrics serve`)
- JSONL event log (`events/events.jsonl`) — structured, append-only
- Real-time Kanban board (`aof board`)
- Mailbox views per agent (`aof watch mailbox`)
- Daemon health endpoint with last-event timestamp tracking

### CLI

Full Commander.js CLI with subcommands for every subsystem. See [README.md](README.md#cli-reference) for the complete reference.

### Developer Experience

- Large file refactoring: god files split into focused modules (none exceed ~300 lines)
- All public APIs have JSDoc comments
- Vitest test suite with unit, integration, and e2e layers
- `aof lint` validates all task files against schema

---

## Roadmap

Layer 3 (planned): Multi-project support, federated org-charts, external event sources, agent capability scoring.
