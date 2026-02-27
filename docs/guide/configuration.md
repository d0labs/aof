---
title: "Configuration Reference"
description: "Org-chart schema, AOF config options, and OpenClaw plugin wiring."
---

AOF uses three layers of configuration: the **org chart** (agent topology and routing), the **AOF config** (runtime behavior), and the **OpenClaw plugin wiring** (gateway integration). This document covers all three.

---

## Org Chart (`org-chart.yaml`)

The org chart is a YAML file that defines agents, teams, organizational units, routing rules, and memory pools. It is the single source of truth for "who can do what" in your AOF deployment.

All org chart changes should go through `aof config set` or `aof config apply` for validation and atomic writes. Source: `src/schemas/org-chart.ts`.

### Top-level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `schemaVersion` | `1` | Yes | -- | Schema version, must be `1` |
| `template` | string | No | -- | Org template name (e.g., `"swe-team"`, `"ops-team"`) |
| `agents` | Agent[] | Yes | -- | List of agent definitions |
| `teams` | Team[] | No | `[]` | Team definitions (legacy; use `orgUnits` for P1.1+) |
| `routing` | RoutingRule[] | No | `[]` | Tag/priority-based routing rules (legacy; use `relationships` for P1.1+) |
| `orgUnits` | OrgUnit[] | No | `[]` | Organizational units (department, team, squad) |
| `groups` | OrgGroup[] | No | `[]` | Cross-cutting agent groups |
| `memberships` | OrgMembership[] | No | `[]` | Agent-to-org-unit memberships |
| `relationships` | OrgRelationship[] | No | `[]` | Inter-agent relationships (escalation, delegation, etc.) |
| `defaults` | OrgDefaults | No | -- | Default policies and capabilities |
| `memoryPools` | MemoryPools | No | -- | Memory V2 pool definitions |
| `memoryCuration` | MemoryCuration | No | -- | Memory curation configuration |
| `roles` | Record<string, RoleMapping> | No | -- | Role-based agent mapping for workflow gates |
| `metadata` | Record<string, unknown> | No | `{}` | Arbitrary metadata |

### Agent Definition (`agents[]`)

Each agent represents a single autonomous entity that can receive and execute tasks.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | Yes | -- | Unique agent ID (must match OpenClaw agent ID) |
| `openclawAgentId` | string | No | -- | OpenClaw agent ID (e.g., `"agent:main:main"`). Used for drift detection |
| `name` | string | Yes | -- | Human-readable display name |
| `description` | string | No | -- | Role description |
| `team` | string | No | -- | Team membership (legacy, use `memberships` for P1.1+) |
| `reportsTo` | string | No | -- | Reports-to agent ID (legacy) |
| `canDelegate` | boolean | No | `false` | Whether this agent can delegate tasks to others |
| `capabilities` | AgentCapabilities | No | `{}` | Capability tags and concurrency settings |
| `comms` | AgentComms | No | `{}` | Communication/dispatch preferences |
| `policies` | OrgPolicies | No | -- | Agent-specific policy overrides |
| `active` | boolean | No | `true` | Whether the dispatcher considers this agent |

#### Agent Capabilities

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tags` | string[] | `[]` | Capability tags used for routing (e.g., `["typescript", "backend"]`) |
| `concurrency` | number | `1` | Maximum concurrent tasks this agent can handle |
| `model` | string | -- | Model assigned to this agent (informational) |
| `provider` | string | -- | Provider type (informational, for cost tracking) |

#### Agent Communication Preferences

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `preferred` | `"spawn"` \| `"send"` \| `"cli"` | `"send"` | Preferred dispatch method |
| `sessionKey` | string | -- | Session key for `sessions_send` dispatch |
| `fallbacks` | (`"spawn"` \| `"send"` \| `"cli"`)[] | `["send", "cli"]` | Fallback methods in priority order |

### Team Definition (`teams[]`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | Yes | -- | Unique team identifier |
| `name` | string | Yes | -- | Human-readable team name |
| `description` | string | No | -- | Team description |
| `lead` | string | No | -- | Lead agent ID |
| `orchestrator` | string | No | -- | Orchestrator agent ID (manages tasks and reviews) |
| `technicalLead` | string | No | -- | Technical lead agent ID |
| `murmur` | MurmurConfig | No | -- | Orchestration review configuration |
| `dispatch` | TeamDispatchConfig | No | -- | Per-team dispatch throttling overrides |

#### Team Dispatch Throttling

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxConcurrent` | number | -- | Maximum concurrent dispatches for this team (overrides global) |
| `minIntervalMs` | number | -- | Minimum interval between dispatches in ms (overrides global) |

#### Murmur Orchestration

Murmur triggers orchestration reviews when specific conditions are met.

| Field | Type | Description |
|-------|------|-------------|
| `triggers` | MurmurTrigger[] | At least one trigger condition |
| `context` | string[] | Context to inject: `"vision"`, `"roadmap"`, `"taskSummary"` |

**Trigger kinds:** `"queueEmpty"`, `"completionBatch"`, `"interval"`, `"failureBatch"`

### Routing Rules (`routing[]`)

Routing rules determine which agent receives a task based on tags and priority.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `matchTags` | string[] | `[]` | Match tasks with these capability tags |
| `matchPriority` | string[] | `[]` | Match tasks with these priorities |
| `targetRole` | string | -- | Route to agents with this role |
| `targetTeam` | string | -- | Route to this team |
| `targetAgent` | string | -- | Route to this specific agent |
| `weight` | number | `100` | Rule priority (lower = evaluated first) |

### Organizational Units (`orgUnits[]`)

P1.1 extension for tree-structured org hierarchy.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | Yes | -- | Unique org unit ID |
| `name` | string | Yes | -- | Human-readable name |
| `type` | string | Yes | -- | Unit type (department, team, squad, etc.) |
| `parentId` | string | No | -- | Parent org unit ID (for tree structure) |
| `description` | string | No | -- | Description |
| `leadId` | string | No | -- | Lead agent ID |
| `active` | boolean | No | `true` | Whether this unit is active |
| `metadata` | Record<string, unknown> | No | `{}` | Arbitrary metadata |

### Relationships (`relationships[]`)

Inter-agent relationships for escalation, delegation, and consultation.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `fromAgentId` | string | Yes | -- | Source agent ID |
| `toAgentId` | string | Yes | -- | Target agent ID |
| `type` | enum | Yes | -- | `"escalates_to"`, `"delegates_to"`, `"consults_with"`, or `"reports_to"` |
| `active` | boolean | No | `true` | Whether this relationship is active |
| `metadata` | Record<string, unknown> | No | `{}` | Arbitrary metadata |

### Role Mapping (`roles`)

Maps abstract roles to concrete agents for workflow gates.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `agents` | string[] | Yes | -- | Agent IDs that can fulfill this role (at least one) |
| `description` | string | No | -- | Human-readable description of responsibilities |
| `requireHuman` | boolean | No | -- | Whether this role requires human involvement |

### Memory Pools (`memoryPools`)

Tiered memory pool definitions for the Memory V2 system.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `hot` | MemoryPoolHot | Yes | -- | Hot tier (always indexed) |
| `hot.path` | string | Yes | -- | Path to hot pool root |
| `hot.description` | string | No | -- | Pool description |
| `hot.agents` | string[] | No | -- | Explicit agent list (all agents if omitted) |
| `warm` | MemoryPoolWarm[] | Yes | -- | Warm tier pools (role-scoped) |
| `warm[].id` | string | Yes | -- | Unique pool ID |
| `warm[].path` | string | Yes | -- | Path to warm pool root |
| `warm[].roles` | string[] | Yes | -- | Role/agent patterns that include this pool |
| `cold` | string[] | Yes | -- | Cold tier paths |
| `adapter` | `"filesystem"` \| `"lancedb"` | No | `"filesystem"` | Memory retrieval adapter |

### Policies

Policies can be set at org-chart defaults level or per-agent.

#### Memory Policy

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scope` | string[] | -- | Memory scope paths (e.g., `["org/engineering", "shared/docs"]`) |
| `tiers` | (`"hot"` \| `"warm"` \| `"cold"`)[] | -- | Allowed memory tiers |
| `readOnly` | boolean | `false` | Read-only access |

#### Tasking Policy

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxConcurrent` | number | `1` | Maximum concurrent tasks |
| `allowSelfAssign` | boolean | `false` | Whether agent can self-assign tasks |
| `requiresReview` | boolean | `false` | Whether tasks require review |
| `allowedPriorities` | string[] | -- | Allowed task priorities |

#### Communication Policy

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowedChannels` | string[] | -- | Allowed communication channels |
| `requiresApproval` | boolean | `false` | Whether communication requires approval |
| `restrictedAgents` | string[] | `[]` | Agent IDs that cannot be communicated with |

#### Context Budget Policy

Prevents context rot by limiting how much context an agent receives.

| Field | Type | Description |
|-------|------|-------------|
| `target` | number | Target budget in characters (ideal context size) |
| `warn` | number | Warning threshold in characters |
| `critical` | number | Critical threshold in characters (must truncate) |

### Example: Minimal Org Chart

```yaml
schemaVersion: 1
agents:
  - id: main-agent
    name: Main Agent
    capabilities:
      tags: [general]
      concurrency: 1
    comms:
      preferred: send
teams: []
routing: []
```

### Example: Team with Roles

```yaml
schemaVersion: 1
agents:
  - id: swe-backend
    name: Backend Engineer
    capabilities:
      tags: [typescript, nodejs, apis]
      concurrency: 2
    comms:
      preferred: send
  - id: swe-frontend
    name: Frontend Engineer
    capabilities:
      tags: [react, css, ui]
      concurrency: 1
    comms:
      preferred: spawn
  - id: swe-lead
    name: Engineering Lead
    capabilities:
      tags: [review, architecture]
      concurrency: 1
    canDelegate: true

teams:
  - id: engineering
    name: Engineering
    lead: swe-lead

roles:
  backend:
    agents: [swe-backend]
    description: Backend implementation
  frontend:
    agents: [swe-frontend]
    description: Frontend implementation
  reviewer:
    agents: [swe-lead]
    description: Code review

routing:
  - matchTags: [backend, api]
    targetRole: backend
    weight: 10
  - matchTags: [frontend, ui]
    targetRole: frontend
    weight: 10
```

### Example: Skill-based Routing

```yaml
schemaVersion: 1
agents:
  - id: agent-alpha
    name: Alpha
    capabilities:
      tags: [python, ml, data]
      concurrency: 3
  - id: agent-beta
    name: Beta
    capabilities:
      tags: [typescript, nodejs, devops]
      concurrency: 2

routing:
  - matchTags: [ml, data]
    targetAgent: agent-alpha
    weight: 1
  - matchTags: [devops]
    targetAgent: agent-beta
    weight: 1
  - matchPriority: [critical]
    targetAgent: agent-alpha
    weight: 0    # highest priority rule
```

---

## AOF Configuration

AOF runtime configuration controls the scheduler, event logging, metrics, and communication behavior. Source: `src/schemas/config.ts`.

### Top-level Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `schemaVersion` | `1` | -- | Schema version, must be `1` |
| `dataDir` | string | `"~/.openclaw/aof"` | Root data directory for AOF runtime data |
| `orgChartPath` | string | `"org-chart.yaml"` | Path to org chart YAML file |
| `vaultRoot` | string | -- | Root directory for vault (Projects/, Resources/) |
| `dispatcher` | DispatcherConfig | `{}` | Scheduler/dispatch settings |
| `metrics` | MetricsConfig | `{}` | Prometheus metrics settings |
| `eventLog` | EventLogConfig | `{}` | Event logging settings |
| `comms` | CommsConfig | `{}` | Communication fallback settings |
| `metadata` | Record<string, unknown> | `{}` | Arbitrary metadata |

### Dispatcher Configuration

Controls how the scheduler scans for tasks and dispatches them.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `intervalMs` | number | `120000` (2 min) | How often the dispatcher scans for pending tasks |
| `defaultLeaseTtlMs` | number | `600000` (10 min) | Default lease TTL for task assignments |
| `maxLeaseRenewals` | number | `3` | Max lease renewals before force-expiry |
| `dryRun` | boolean | `false` | Log decisions without dispatching |
| `maxConcurrentDispatches` | number | `3` | Maximum concurrent dispatches globally |
| `minDispatchIntervalMs` | number | `0` | Minimum interval between dispatches (0 = disabled) |
| `maxDispatchesPerPoll` | number | `10` | Maximum dispatches per poll cycle |

### Metrics Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable Prometheus metrics export |
| `port` | number | `9101` | Port for the metrics HTTP server |
| `path` | string | `"/metrics"` | Metrics endpoint path |

### Event Log Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable event logging |
| `maxEventsPerFile` | number | `10000` | Max events per log file before rotation |
| `maxFiles` | number | `30` | Max total log files to retain |

### Communication Configuration

Controls how the dispatcher communicates with agents.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `methodPriority` | (`"spawn"` \| `"send"` \| `"cli"`)[] | `["send", "spawn", "cli"]` | Default dispatch method priority |
| `spawnTimeoutMs` | number | `30000` | Timeout for spawn attempts |
| `sendTimeoutMs` | number | `60000` | Timeout for send attempts |
| `cliTimeoutMs` | number | `120000` | Timeout for CLI attempts |

---

## OpenClaw Plugin Wiring

AOF registers as an OpenClaw plugin via `openclaw.plugin.json`. This section covers the plugin manifest and the gateway configuration needed to activate AOF.

### Plugin Manifest (`openclaw.plugin.json`)

The plugin manifest declares AOF's identity and configuration schema. Source: `openclaw.plugin.json`.

| Field | Value | Description |
|-------|-------|-------------|
| `id` | `"aof"` | Plugin identifier |
| `name` | `"AOF -- Agentic Ops Fabric"` | Display name |
| `version` | `"0.1.0"` | Plugin version |
| `kind` | `"memory"` | Plugin kind |
| `main` | `"dist/plugin.js"` | Entry point |
| `configSchema` | object | JSON Schema for plugin config (see below) |

### Plugin Config Schema

These fields go in the `plugins.aof.config` section of your `openclaw.json`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dataDir` | string | `"~/.openclaw/aof"` | AOF state directory |
| `pollIntervalMs` | number | `30000` | Scheduler poll interval in milliseconds |
| `defaultLeaseTtlMs` | number | `300000` | Default task lease TTL in milliseconds |
| `dryRun` | boolean | `false` | If true, scheduler observes but does not dispatch |
| `gatewayUrl` | string | auto-detected | OpenClaw gateway URL for HTTP dispatch |
| `gatewayToken` | string | auto-detected | Gateway authentication token |
| `heartbeatTtlMs` | number | `300000` | Heartbeat TTL in milliseconds |
| `maxConcurrentDispatches` | number | `3` | Maximum concurrent dispatched tasks (1-50) |
| `modules` | object | -- | Module enable/disable flags |
| `modules.memory.enabled` | boolean | `true` | Enable memory module |
| `modules.dispatch.enabled` | boolean | `true` | Enable dispatch module |
| `modules.murmur.enabled` | boolean | `true` | Enable murmur orchestration module |
| `modules.linter.enabled` | boolean | `true` | Enable linter module |
| `memory` | object | -- | Memory subsystem configuration |
| `memory.embedding.provider` | `"openai"` \| `"ollama"` | -- | Embedding provider |
| `memory.embedding.model` | string | -- | Embedding model name |
| `memory.embedding.baseUrl` | string | -- | Embedding API base URL |
| `memory.embedding.apiKey` | string | -- | Embedding API key |
| `memory.embedding.dimensions` | number | -- | Embedding dimensions |
| `memory.search.hybridEnabled` | boolean | `true` | Enable hybrid search (vector + BM25) |
| `memory.search.vectorWeight` | number | `0.7` | Vector search weight (0-1) |
| `memory.search.bm25Weight` | number | `0.3` | BM25 search weight (0-1) |
| `memory.search.maxResults` | number | `10` | Maximum search results |
| `memory.search.tierBoost.hot` | number | `1.0` | Score boost for hot tier results |
| `memory.search.tierBoost.warm` | number | `0.8` | Score boost for warm tier results |
| `memory.search.tierBoost.cold` | number | `0.5` | Score boost for cold tier results |
| `memory.indexPaths` | string[] | -- | Additional paths to index |

### Gateway Configuration Example

To enable AOF in your OpenClaw gateway, add it to the `plugins` section of `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "aof": {
      "enabled": true,
      "config": {
        "dataDir": "~/.openclaw/aof",
        "pollIntervalMs": 30000,
        "maxConcurrentDispatches": 3,
        "modules": {
          "memory": { "enabled": true },
          "dispatch": { "enabled": true }
        },
        "memory": {
          "embedding": {
            "provider": "openai",
            "model": "text-embedding-3-small",
            "dimensions": 1536
          },
          "search": {
            "hybridEnabled": true,
            "vectorWeight": 0.7,
            "bm25Weight": 0.3
          }
        }
      }
    }
  }
}
```

> **Note:** `gatewayUrl` and `gatewayToken` are auto-detected from the OpenClaw runtime context. Only set them explicitly if auto-detection fails.

### Managing Config via CLI

AOF provides CLI commands for org chart configuration management:

```bash
# Get a config value (dot-notation)
aof config get agents.swe-backend.active

# Set a config value (validates + atomic write)
aof config set agents.swe-backend.active true

# Preview a change without applying
aof config set agents.swe-backend.active false --dry-run

# Validate the entire org chart
aof org validate
```

All changes through `aof config set` are validated against the Zod schema and checked for referential integrity before being written atomically (write to temp file, validate, rename).
