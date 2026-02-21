# AOF Deployment Guide

**Audience:** Operators, SREs, DevOps teams  
**Scope:** OpenClaw plugin mode, standalone daemon mode, and conflict prevention

---

## Overview

AOF can run in **two modes**:

1. **Plugin mode (recommended for OpenClaw):** AOF runs inside the OpenClaw Gateway as a plugin.
2. **Daemon mode (standalone):** AOF runs as a detached scheduler process managed by the CLI.

**Important:** The plugin scheduler and daemon both **poll tasks and dispatch**. They **must NOT run simultaneously** for the same project.

---

## Plugin Mode (OpenClaw) — Recommended

### Auto-discovery

Place the AOF plugin at:

```
~/.openclaw/extensions/aof/
```

OpenClaw auto-discovers extensions from this path on gateway start.

### Configuration

Configure via **gateway config** (not `settings`):

```yaml
plugins:
  entries:
    aof:
      config:
        dryRun: false
        gatewayUrl: "http://127.0.0.1:19003"
        gatewayToken: "YOUR_GATEWAY_TOKEN"
```

**Required for dispatch:**

```yaml
gateway:
  tools:
    allow:
      - sessions_spawn
```

> ✅ `plugins.entries.aof.config` is the correct key. **Do not use** `plugins.entries.aof.settings`.

### Verifying plugin mode is active

- OpenClaw Gateway logs show AOF plugin startup
- `/aof/status` responds:
  ```bash
  curl http://localhost:19003/aof/status
  ```
- Plugin scheduler logs appear in `~/.openclaw/logs/gateway.log`

---

## Daemon Mode (Standalone)

The daemon runs the scheduler loop and exposes `/health`.

### CLI lifecycle commands

```bash
# Start daemon (background)
aof daemon start --port 18000 --bind 127.0.0.1

# Status
aof daemon status --port 18000

# Stop
aof daemon stop
```

### Health endpoint

```bash
curl http://127.0.0.1:18000/health
```

### Verifying daemon mode is active

- `aof daemon status` shows PID + uptime
- PID file exists: `<dataDir>/daemon.pid`
- `/health` returns 200

---

## Conflict Prevention (Plugin + Daemon)

**Never run plugin and daemon simultaneously** for the same AOF project. Both poll and dispatch.

### How to detect conflicts

- **Plugin active** if `/aof/status` responds and Gateway logs show `[AOF]` activity.
- **Daemon active** if `aof daemon status` shows a running PID or `daemon.pid` exists.

### Recommended workflow

| Use Case | Mode | Actions |
|---|---|---|
| Running inside OpenClaw Gateway | **Plugin** | Enable plugin, **do not** run daemon |
| Running standalone (no OpenClaw) | **Daemon** | Run daemon, **disable** plugin |

> TODO: The daemon CLI does **not** currently check for an active OpenClaw plugin before starting. Operators must manually ensure only one scheduler is running.

---

## Deployment Steps (Docker / OpenClaw Environments)

### 1) Install AOF plugin (OpenClaw)

1. Copy AOF to OpenClaw extensions:
   ```bash
   mkdir -p /home/node/.openclaw/extensions
   cp -r /opt/aof /home/node/.openclaw/extensions/aof
   ```
2. Configure gateway:
   ```yaml
   gateway:
     tools:
       allow:
         - sessions_spawn

   plugins:
     entries:
       aof:
         config:
           dryRun: false
           gatewayUrl: "http://127.0.0.1:19003"
           gatewayToken: "${GATEWAY_TOKEN}"
   ```
3. Restart gateway:
   ```bash
   openclaw gateway restart
   ```
4. Verify:
   ```bash
   curl http://localhost:19003/aof/status
   ```

### 2) Standalone daemon (non-OpenClaw)

If running outside OpenClaw, use the daemon CLI (located in `dist/cli/`).

```bash
# from AOF install
node dist/cli/index.js daemon start --root /data/aof --port 18000
```

> Note: The daemon CLI must be invoked directly from the AOF distribution (e.g., `node dist/cli/index.js daemon start`).

Use Docker or systemd to supervise. Ensure **only one daemon** runs per project.

---

## TaskFrontmatter (Required Fields)

Every AOF task frontmatter must include:

- `schemaVersion`
- `id`
- `project`
- `title`
- `status`
- `priority`
- `routing`
- `createdAt`
- `updatedAt`
- `lastTransitionAt`
- `createdBy`
- `dependsOn`
- `metadata`

---

## Murmur Orchestration Configuration

**Murmur** is AOF's team-scoped orchestration trigger system. It automatically creates and dispatches review tasks to orchestrator agents based on configurable trigger conditions.

### What Murmur Does

Murmur monitors team task queues and statistics, evaluates trigger conditions, and spawns orchestration review tasks when conditions are met. This enables periodic team health checks, sprint retrospectives, and queue management without manual intervention.

### Enabling Murmur for a Team

Configure murmur in `org-chart.yaml` under team definitions:

```yaml
teams:
  - id: swe-team
    name: "Software Engineering Team"
    orchestrator: swe-pm  # Required: agent ID for review tasks
    murmur:
      triggers:
        - kind: queueEmpty
        - kind: completionBatch
          threshold: 10
        - kind: interval
          intervalMs: 86400000  # 24 hours
      context:
        - vision
        - roadmap
        - taskSummary
```

**Required fields:**
- `team.orchestrator` — Agent ID that will receive review tasks (typically a PM or lead)
- `team.murmur.triggers` — Array of trigger conditions (at least one required)

**Optional fields:**
- `team.murmur.context` — Context sections to inject into review tasks (e.g., `vision`, `roadmap`, `taskSummary`)

### Trigger Types

Murmur evaluates triggers in order; the first trigger that fires wins (short-circuit evaluation). A review will never fire if one is already in progress (idempotency guard).

#### 1. `queueEmpty`

Fires when **both** ready and in-progress queues are empty.

```yaml
triggers:
  - kind: queueEmpty
```

**Use case:** End-of-sprint retrospectives, idle capacity allocation.

#### 2. `completionBatch`

Fires when the team completes a threshold number of tasks since the last review.

```yaml
triggers:
  - kind: completionBatch
    threshold: 10  # Required: number of completions
```

**Use case:** Regular progress check-ins, velocity tracking.

#### 3. `interval`

Fires after a fixed time interval since the last review.

```yaml
triggers:
  - kind: interval
    intervalMs: 86400000  # Required: interval in milliseconds (24 hours)
```

**Use case:** Daily standups, weekly sprint planning.

**Note:** If no review has ever occurred, fires immediately.

#### 4. `failureBatch`

Fires when the team accumulates a threshold number of failed/dead-lettered tasks since the last review.

```yaml
triggers:
  - kind: failureBatch
    threshold: 3  # Required: number of failures
```

**Use case:** Incident response, quality degradation alerts.

### Murmur State Directory

Murmur persists per-team state in `.murmur/<team-id>.json` at the project root. These files track:

- `lastReviewAt` — ISO timestamp of last murmur review
- `completionsSinceLastReview` — Task completion counter
- `failuresSinceLastReview` — Task failure counter
- `currentReviewTaskId` — Review task ID if one is in progress (idempotency guard)
- `reviewStartedAt` — ISO timestamp when current review started
- `lastTriggeredBy` — Which trigger kind fired last

**State files are automatically created** when the scheduler runs. Do not manually edit these files.

**Backup considerations:** Include `.murmur/` in project backups if you need to preserve trigger history across environment migrations.

### Review Timeout and Stale Cleanup

**Default review timeout:** 30 minutes (configurable via scheduler options)

If a review task remains in progress for longer than `reviewTimeoutMs`, murmur's cleanup logic:

1. Logs a stale review warning
2. Clears `currentReviewTaskId` from state (allows new reviews to fire)
3. Does **not** cancel or transition the stale task (manual intervention required)

**Timeout is wall-clock time**, not CPU time. A paused or blocked orchestrator session will trigger stale cleanup.

**Manual recovery:** If a review task is truly stuck, transition it to `blocked` or `done` manually:

```bash
bd trans <task-id> blocked "Orchestrator unresponsive"
```

### Integration with Scheduler

Murmur evaluation runs **after** the normal dispatch cycle. The scheduler:

1. Dispatches ready tasks to agents (normal cycle)
2. Evaluates murmur triggers for teams with `murmur` config
3. Creates and dispatches review tasks if triggers fire
4. Respects global concurrency limits (won't dispatch reviews if at max capacity)

### Troubleshooting

**Review tasks not firing:**
- Check `team.orchestrator` is set and agent exists in `agents` list
- Verify `team.murmur.triggers` is non-empty and valid
- Check scheduler logs for `[AOF] Murmur:` messages
- Inspect `.murmur/<team-id>.json` for `currentReviewTaskId` (blocks new reviews)

**Review tasks stuck in progress:**
- Check orchestrator agent session is active (`openclaw sessions list`)
- Verify review timeout hasn't been exceeded (default 30 minutes)
- Manually transition stale review tasks to `blocked` if needed

**Trigger not firing when expected:**
- Murmur evaluates triggers in order; first match wins
- Check state counters in `.murmur/<team-id>.json`
- Verify threshold values match your expectations

---

## Critical: Plugin configSchema (OpenClaw 2026.2.15+)

OpenClaw validates plugin config against `openclaw.configSchema` in `package.json`. **Missing schema = validation error on restart.**

The AOF `package.json` must include:

```json
{
  "openclaw": {
    "id": "aof",
    "configSchema": {
      "type": "object",
      "properties": {
        "dryRun": { "type": "boolean", "default": true },
        "dataDir": { "type": "string" },
        "gatewayUrl": { "type": "string" },
        "gatewayToken": { "type": "string" },
        "pollIntervalMs": { "type": "number" },
        "defaultLeaseTtlMs": { "type": "number" },
        "heartbeatTtlMs": { "type": "number" }
      },
      "additionalProperties": false
    }
  }
}
```

**Any config property not in the schema will cause "must NOT have additional properties" and prevent gateway restart.**

## Critical: Agent Spawn Permissions

For AOF to dispatch tasks to agents, the **main agent** (or whichever agent the AOF executor uses as `sessionKey`) must have:

```yaml
agents:
  list:
    - id: main
      subagents:
        allowAgents: ["*"]  # Or list specific agent IDs
```

Without this, `sessions_spawn` returns "Agent not found" even though the agent exists in the config. The `agents_list` tool will show `allowAny: false` with only the requesting agent visible.

## Critical: Config Change Protocol (Docker/Container Environments)

1. **Use `openclaw config get/set`** — never edit `openclaw.json` directly
2. **Always run `openclaw doctor`** before restarting — if ANY issues, fix first
3. **Use `openclaw gateway restart`** (or `kill -USR1 <gateway-pid>` in Docker) — **NEVER `kill -9`**
4. Killing the gateway process in Docker crashes the entire container (gateway is PID 1's child)
5. If `openclaw gateway restart` fails (no systemctl), use `kill -USR1 $(pgrep -f openclaw-gateway)`

## Troubleshooting

**Plugin not dispatching:**
- Ensure `gateway.tools.allow: ["sessions_spawn"]`
- Verify `plugins.entries.aof.config` is used (not `settings`)
- Check `agents_list` via HTTP — should show `allowAny: true` and target agents
- Check `main.subagents.allowAgents: ["*"]` is set
- Check `/aof/status` and gateway logs

**"Agent not found" but agent exists in config:**
- Check `subagents.allowAgents` on the requesting agent (usually `main`)
- Use `curl -X POST /tools/invoke` with `agents_list` to verify visibility

**"must NOT have additional properties" on restart:**
- AOF plugin `package.json` is missing `openclaw.configSchema`, or the schema doesn't include all config properties being set
- Fix the schema, then restart

**Daemon not dispatching:**
- Check `aof daemon status`
- Verify `/health` returns 200
- Confirm daemon is not running alongside the plugin

---

## References

- Recovery runbook: `docs/RECOVERY-RUNBOOK.md`
- Watchdog design: `docs/design/DAEMON-WATCHDOG-DESIGN.md`
