# Getting Started with AOF

This guide walks you through installing AOF, setting up your first org chart, and dispatching your first task. By the end, you will have a running AOF daemon that automatically assigns and dispatches tasks to agents.

---

## Prerequisites

Before you begin, make sure you have:

- **Node.js >= 22.0.0** (LTS recommended)
- **An OpenClaw gateway** running on your machine or network

AOF is an OpenClaw plugin. It runs inside the OpenClaw gateway process and uses the gateway to dispatch work to agents.

> **Tip:** Check your Node version with `node --version`. If you need to upgrade, use [nvm](https://github.com/nvm-sh/nvm) or your system's package manager.

---

## Installation

Install AOF using the one-line installer:

```bash
curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
```

The installer will:
1. Download the latest AOF release tarball
2. Extract it to `~/.openclaw/aof/`
3. Install Node.js dependencies
4. Run `aof setup` to complete configuration

You can also specify a custom install path or version:

```bash
sh install.sh --prefix /custom/path --version 1.0.0
```

---

## First-time Setup

After installation, AOF runs `aof setup` automatically. If you need to re-run it:

```bash
aof setup
```

The setup command does the following:

1. **Wizard** (interactive) -- Asks about your data directory, org chart location, and OpenClaw integration preferences. Use `--auto` to accept all defaults.
2. **Directory scaffolding** -- Creates the AOF data directory structure (tasks, events, views, memory).
3. **OpenClaw plugin wiring** -- Registers AOF in your `openclaw.json` gateway config. If OpenClaw is not detected, setup continues with a warning.

```bash
# Non-interactive setup with defaults
aof setup --auto --template minimal
```

---

## Create Your Org Chart

The org chart is a YAML file that defines your agents, teams, and routing rules. It is the single source of truth for "who can do what" in your organization.

Create a file called `org-chart.yaml` in your AOF data directory:

```yaml
schemaVersion: 1
agents:
  - id: main-agent
    name: Main Agent
    description: General-purpose agent for all tasks
    capabilities:
      tags: [general]
      concurrency: 1
    comms:
      preferred: send
      fallbacks: [spawn, cli]
    active: true

teams:
  - id: default
    name: Default Team
    lead: main-agent

routing: []
```

### Key fields

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `1` (literal) | Schema version, always `1` |
| `agents` | array | List of agent definitions |
| `agents[].id` | string | Unique agent identifier (must match OpenClaw agent ID) |
| `agents[].name` | string | Human-readable display name |
| `agents[].capabilities.tags` | string[] | Capability tags used for routing |
| `agents[].capabilities.concurrency` | number | Maximum concurrent tasks (default: 1) |
| `agents[].comms.preferred` | `spawn` \| `send` \| `cli` | Preferred dispatch method (default: `send`) |
| `agents[].active` | boolean | Whether the dispatcher considers this agent (default: `true`) |
| `teams` | array | Team definitions for grouping agents |
| `routing` | array | Tag/priority-based routing rules |

For a complete schema reference, see the [Configuration Reference](configuration.md).

---

## Initialize AOF

Once your org chart is ready, initialize AOF:

```bash
aof init
```

The `init` command:
- Validates your org chart against the schema
- Sets up OpenClaw integration (plugin registration, memory module, skill definition)
- Creates required directory structures

Use `--yes` for non-interactive mode or `--skip-openclaw` to skip OpenClaw integration:

```bash
aof init --yes
```

---

## Start the Daemon

AOF runs as a background daemon that continuously polls for tasks and dispatches them to agents.

### Install and start the daemon

```bash
aof daemon install
```

This writes an OS service file (launchd on macOS, systemd on Linux) and starts the daemon process. The daemon includes:
- A poll loop that scans for pending tasks on a configurable interval
- An HTTP health endpoint on a Unix domain socket
- Crash recovery with PID file locking

### Check daemon status

```bash
aof daemon status
```

This queries the daemon's health endpoint and displays:
- Whether the daemon is running
- Last poll time and duration
- Task counts by status
- Active leases

```bash
# JSON output for scripting
aof daemon status --json
```

### Other daemon commands

```bash
aof daemon stop          # Stop the daemon gracefully
aof daemon uninstall     # Stop and remove the OS service file
```

---

## Create Your First Task

Tasks in AOF are Markdown files with YAML frontmatter. You can create them via the CLI:

```bash
aof task create "Implement user authentication" --priority high --agent main-agent
```

This creates a task file with the following structure:

```markdown
---
schemaVersion: 1
id: TASK-2026-02-27-001
project: _inbox
title: Implement user authentication
status: ready
priority: high
routing:
  agent: main-agent
  tags: []
createdAt: 2026-02-27T12:00:00Z
updatedAt: 2026-02-27T12:00:00Z
lastTransitionAt: 2026-02-27T12:00:00Z
createdBy: cli
dependsOn: []
---
```

### Task ID format

Task IDs follow the pattern `TASK-YYYY-MM-DD-NNN` (e.g., `TASK-2026-02-27-001`). They are generated automatically and are globally unique within a project.

### Task statuses

| Status | Description |
|--------|-------------|
| `backlog` | Created, not yet triaged |
| `ready` | Ready to be picked up by the scheduler |
| `in-progress` | Agent is actively working (has a lease) |
| `blocked` | Waiting on an external dependency |
| `review` | Work complete, awaiting review |
| `done` | Successfully completed |
| `cancelled` | Cancelled by user or system |
| `deadletter` | Failed dispatch 3 times, requires manual intervention |

### CLI options for task creation

```bash
aof task create <title> [options]

Options:
  -p, --priority <priority>   Priority: low, normal, high, critical (default: normal)
  -t, --team <team>           Target team for routing
  -a, --agent <agent>         Target agent (bypasses routing)
  --tags <tags>               Comma-separated capability tags
  --project <id>              Project ID (default: _inbox)
```

---

## Watch It Dispatch

Once the daemon is running and you have a task in `ready` status, the scheduler will:

1. **Scan** for ready tasks on each poll cycle
2. **Match** tasks to agents using routing rules and capability tags
3. **Acquire a lease** on the matched task (preventing double-dispatch)
4. **Dispatch** the task to the agent via the OpenClaw gateway
5. **Track** the task through in-progress, review, and done states

### Monitor progress

```bash
# List all tasks with their current status
aof scan

# Display a Kanban board view
aof board

# View recent events (task transitions, dispatches, lease operations)
aof events
```

### Example: watching a task flow

```
$ aof scan
STATUS        COUNT
─────────────────────
ready         1
in-progress   0
done          0

$ aof daemon status
Daemon: running (PID 12345)
Last poll: 2s ago (42ms)
Tasks: 1 ready, 0 in-progress, 0 done

# After the scheduler dispatches your task:
$ aof scan
STATUS        COUNT
─────────────────────
ready         0
in-progress   1
done          0

# After the agent completes the task:
$ aof scan
STATUS        COUNT
─────────────────────
ready         0
in-progress   0
done          1
```

---

## Next Steps

Now that you have AOF running with a dispatched task, explore these topics:

- **[Configuration Reference](configuration.md)** -- Full org-chart schema, AOF config options, and OpenClaw plugin wiring
- **[CLI Reference](cli-reference.md)** -- Complete command reference (auto-generated from source)
- **[Task Format](task-format.md)** -- Full task frontmatter schema and body conventions
- **[Workflow Gates](workflow-gates.md)** -- Define multi-stage review workflows
- **[Memory Module](memory.md)** -- Set up semantic memory with HNSW vector search
- **[Protocols](protocols.md)** -- Inter-agent communication protocols

---

## Troubleshooting

### Daemon won't start

```bash
# Check if another instance is running
aof daemon status

# Check for stale PID file
ls ~/.openclaw/aof/daemon.pid

# Force stop and restart
aof daemon stop --force
aof daemon install
```

### Task stuck in ready

- Verify the daemon is running: `aof daemon status`
- Check that the target agent exists in your org chart and is `active: true`
- Ensure the agent's `capabilities.tags` match the task's `routing.tags`
- Check for dispatch errors in the event log: `aof events`

### OpenClaw integration issues

- Verify OpenClaw is running: `openclaw gateway status`
- Check plugin registration: look for `"aof"` in `~/.openclaw/openclaw.json` under `plugins`
- Re-run integration: `aof init`
