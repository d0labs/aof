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

## Deployment Steps (Docker / Mule-like Environments)

### 1) Install AOF plugin (Mule/OpenClaw)

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

> Note: The daemon CLI is **not installed on Mule** by default. It must be invoked from the AOF distribution.

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
