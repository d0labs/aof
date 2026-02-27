---
title: "Org Charts"
description: "Declarative YAML definitions for agents, teams, roles, and routing in AOF."
---

The **org chart** (`org/org-chart.yaml`) is the foundational declaration of your agent topology. It defines who exists, what they can do, how they're organized, and what memory they can access. The scheduler and gate evaluator use the org chart as the single source of truth for routing decisions.

## Structure

```yaml
schemaVersion: 1           # Always 1

agents: []                 # Agent definitions
teams: []                  # Team groupings (legacy; prefer orgUnits)
orgUnits: []               # Org units (departments, squads) — P1.1+
groups: []                 # Cross-cutting groups — P1.1+
memberships: []            # Agent-to-unit memberships — P1.1+
relationships: []          # Agent relationships (escalation, delegation) — P1.1+
roles: {}                  # Role-to-agent mappings for workflow gates
routing: []                # Tag/priority-based dispatch rules
memoryPools: {}            # Memory tier configuration
defaults: {}               # Default policies
```

## Agents

Each agent definition maps an ID to its capabilities, communication preferences, and policies:

```yaml
agents:
  - id: swe-backend
    name: Backend Engineer Agent
    description: "Implements server-side features in TypeScript/Node"
    team: engineering          # Legacy team membership
    active: true               # false = skipped by scheduler

    capabilities:
      tags:
        - typescript
        - nodejs
        - apis
      concurrency: 2           # Max parallel tasks for this agent
      model: claude-opus-4     # Informational — for cost tracking
      provider: anthropic      # Informational

    comms:
      preferred: send          # "spawn" | "send" | "cli"
      sessionKey: "agent:main:swe-backend"  # For sessions_send dispatch
      fallbacks:
        - cli

    policies:
      tasking:
        maxConcurrent: 2
        allowSelfAssign: false
        requiresReview: true
      memory:
        scope:
          - org/engineering
          - shared/docs
        tiers: [hot, warm, cold]
        readOnly: false
```

### Key Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | Must match OpenClaw agent ID |
| `name` | string | required | Display name |
| `active` | boolean | `true` | Inactive agents are skipped by the scheduler |
| `capabilities.concurrency` | number | `1` | Max concurrent in-progress tasks |
| `comms.preferred` | enum | `"send"` | Preferred dispatch method |
| `comms.sessionKey` | string | — | Required for `send` dispatch method |
| `canDelegate` | boolean | `false` | Whether agent can delegate tasks to others |

### Communication Methods

| Method | Description |
|--------|-------------|
| `send` | Send a message to an existing agent session via `sessions_send` |
| `spawn` | Spawn a new agent session for each task |
| `cli` | Deliver via CLI (for human-operated agents) |

## Teams

Teams group agents for organizational visibility and team-level dispatch configuration:

```yaml
teams:
  - id: engineering
    name: Engineering
    description: "Core product engineering team"
    lead: swe-architect           # Team lead agent
    orchestrator: swe-pm          # PM who manages task queue
    technicalLead: swe-architect  # Technical advisor

    # Per-team dispatch throttling (overrides global config)
    dispatch:
      maxConcurrent: 5
      minIntervalMs: 500

    # Murmur orchestration reviews
    murmur:
      triggers:
        - kind: queueEmpty         # Trigger when team queue drains
        - kind: completionBatch    # Trigger every N completions
          threshold: 10
        - kind: interval
          intervalMs: 3600000      # Hourly review
      context:
        - vision
        - roadmap
        - taskSummary
```

## Roles

Roles are the bridge between abstract workflow gates and concrete agents. A gate specifies a `role`; the org chart maps that role to one or more agents:

```yaml
roles:
  developer:
    agents:
      - swe-backend
      - swe-frontend
    description: "Implements features and fixes"

  reviewer:
    agents:
      - swe-architect
    description: "Reviews code quality and architecture"

  qa:
    agents:
      - swe-qa
    description: "Performs quality assurance and testing"
    requireHuman: false          # true = gate requires human agent approval

  po:
    agents:
      - product-owner
    description: "Product Owner approval"
    requireHuman: true           # Final approval must be human
```

When a gate requires `role: reviewer`, AOF resolves this through the `roles` mapping to find the correct agent. This decouples workflow definitions from specific agent IDs — you can rotate agents without changing any workflow files.

## Routing Rules

Routing rules allow tag- and priority-based automatic routing for tasks that don't have explicit `routing.role` or `routing.agent` set:

```yaml
routing:
  - matchTags: [bug, critical]
    targetRole: swe-backend
    weight: 10                   # Lower = evaluated first

  - matchPriority: [critical]
    targetTeam: engineering
    weight: 20

  - matchTags: [frontend, ui]
    targetRole: swe-frontend
    weight: 50
```

> **Note:** Explicit `routing.agent` in a task frontmatter always wins over routing rules. Rules are a fallback for tasks without explicit routing.

## Memory Pools

The org chart defines the memory pool topology for the tiered memory system:

```yaml
memoryPools:
  hot:
    path: memory/hot
    description: "Always-indexed shared memory"
    agents: []               # empty = all agents

  warm:
    - id: engineering-warm
      path: memory/warm/engineering
      description: "Engineering team shared context"
      roles:
        - developer
        - reviewer

    - id: per-agent
      path: memory/warm/agents
      description: "Per-agent working memory"
      roles:
        - "*"                # All roles

  cold:
    - memory/cold/archive
    - memory/cold/docs

  adapter: filesystem        # "filesystem" | "lancedb"
```

## Org Units (P1.1+)

For more complex organizational structures, use `orgUnits` instead of `teams`:

```yaml
orgUnits:
  - id: product
    type: department
    name: Product
    description: "Product and design"

  - id: engineering
    type: department
    name: Engineering
    parentId: product        # Engineering reports to Product

  - id: platform
    type: squad
    name: Platform Squad
    parentId: engineering
    leadId: swe-architect

memberships:
  - agentId: swe-backend
    orgUnitId: platform
    role: engineer
    primary: true

relationships:
  - fromAgentId: swe-backend
    toAgentId: swe-architect
    type: escalates_to
    active: true

  - fromAgentId: swe-architect
    toAgentId: swe-pm
    type: reports_to
```

## Generating an SDLC Org Chart

The `aof init` wizard performs a shallow import of your OpenClaw agents into a flat list. To structure these agents into a proper Software Development Life Cycle (SDLC) with teams, roles, routing rules, and workflow gates, we recommend using a **collaborative LLM prompt**.

After running `aof init`, hand the following prompt to your main agent (or architect agent) to interactively design your org chart:

> **SDLC Setup Prompt:**
>
> The AOF org chart has been initialized with our OpenClaw agents. Now I need your help configuring it for our SDLC workflow. Here's what I want to achieve:
>
> **Team structure:**
> Our SWE agents (swe-architect, swe-po, swe-pm, swe-backend, swe-frontend, swe-qa, swe-security, swe-tech-writer, etc.) should form an "engineering" team with proper roles and an SDLC lifecycle.
>
> **What I want configured:**
> 1. **Roles:** architect (design+orchestrate), po/pm (requirements), backend/frontend/ai (implementation), security (cross-cutting review), qa (validation), tech-writer (documentation).
> 2. **Gates:** Work must flow through: `backlog → ready → in-progress → review → done`. Gate rules: all implementation tasks require a passing test run before `review`. Security review is required for tasks tagged `security` or `auth`. Tech-writer review is required for tasks tagged `docs` or `api-change`.
> 3. **Routing rules:** Tasks tagged `backend` → swe-backend; `frontend` → swe-frontend; `security` → swe-security; `docs` → swe-tech-writer; `qa` → swe-qa. Untagged tasks → swe-architect triage.
> 4. **Protocols:** TDD required — tests must be written before implementation. No PRs without tests. Code review by at least one peer before `done`. Documentation updated with every API change.
> 5. **Communication:** Architect coordinates; specialists receive task briefs via AOF dispatch; results reported back via `aof task complete`. No direct agent-to-agent side channels for task work (all work goes through AOF queue).
>
> Please read the current org chart at `org/org-chart.yaml`, then propose updates to implement this. Show me the diff and confirm with me before writing. Make the gates and routing rules explicit in the YAML — not implied.

This prompt is intentionally collaborative: the agent proposes and you confirm. This prevents a brittle, hardcoded SDLC configuration that doesn't fit your actual team norms.

## Drift Detection

AOF can detect when the org chart definition drifts from reality (e.g., an agent defined as active but not actually running):

```bash
aof org drift
```

This checks `openclawAgentId` fields against the OpenClaw gateway's registered sessions.

## CLI Commands

```bash
# Validate schema and referential integrity
aof org validate

# Display org chart in readable format
aof org show

# Lint for referential integrity
aof org lint

# Detect drift vs active agents
aof org drift
```
