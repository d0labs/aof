# Task Brief: Daemon CLI Integration (AOF-r5g)

**Priority**: P1 (CRITICAL BLOCKER)
**Task ID**: AOF-r5g
**Assignee**: Backend Engineer
**Blocks**: All Mule deployment and autonomous operation

## Context

We built the daemon core logic in Phase 1.5 (including PID file locking), but **never wired it to the CLI**. This is a critical gap that prevents AOF from running autonomously. Without this, the Mule experiment cannot proceed.

**What exists:**
- ✅ `src/daemon/daemon.ts` — Core daemon logic with PID lock
- ✅ `src/daemon/health.ts` — Health endpoint
- ✅ `src/daemon/server.ts` — HTTP server
- ✅ `src/daemon/index.ts` — Public exports

**What's missing:**
- ❌ CLI commands to actually run the daemon
- ❌ `aof daemon start/stop/status/restart`

## Requirements

### 1. Add `src/cli/commands/daemon.ts`

Implement four subcommands:

#### `aof daemon start [options]`
- Fork daemon process (detached)
- Daemon writes PID to `${dataDir}/daemon.pid`
- CLI exits after confirming daemon started
- Options:
  - `--port <number>` (default: 18000)
  - `--bind <address>` (default: 127.0.0.1)
  - `--data-dir <path>` (default: from --root or cwd)
  - `--log-level <level>` (default: info)
- Error handling:
  - If PID file exists and process alive → error "Daemon already running"
  - If port in use → error with clear message
  - If daemon fails to start → read startup logs and report

#### `aof daemon stop [options]`
- Read PID from `${dataDir}/daemon.pid`
- Send SIGTERM to process
- Wait for graceful shutdown (up to 10s)
- If still alive after 10s → SIGKILL
- Remove PID file
- Options:
  - `--timeout <seconds>` (default: 10)
- Error handling:
  - If no PID file → "Daemon not running"
  - If process doesn't exist → clean up stale PID file

#### `aof daemon status`
- Check if PID file exists
- Check if process is alive (kill -0)
- If running: display PID, uptime, health endpoint URL
- If not running: check for stale PID file
- Exit code: 0 if running, 1 if not

#### `aof daemon restart [options]`
- Stop then start
- Pass through all options to start
- Wait for clean stop before starting

### 2. Integration Points

**Import from daemon module:**
```typescript
import { startDaemon, type DaemonOptions } from '../daemon/index.js';
```

**CLI structure:**
```typescript
// src/cli/commands/daemon.ts
import { Command } from 'commander';

export const daemonCommand = new Command('daemon')
  .description('Daemon management commands');

daemonCommand
  .command('start')
  .description('Start the AOF daemon')
  .option('--port <number>', 'HTTP port', '18000')
  .option('--bind <address>', 'Bind address', '127.0.0.1')
  .option('--data-dir <path>', 'Data directory')
  .action(async (options) => {
    // Implementation
  });

// ... stop, status, restart commands
```

**Wire into main CLI:**
```typescript
// src/cli/index.ts
import { daemonCommand } from './commands/daemon.js';

program.addCommand(daemonCommand);
```

### 3. Tests

**Unit tests** (`src/cli/commands/__tests__/daemon.test.ts`):
- Command parsing (flags, defaults)
- Error messages
- Help text

**Integration tests** (can be part of existing daemon tests):
- Start → status shows running → stop → status shows not running
- Start with daemon already running → error
- Stop with no daemon → clean exit
- Restart cycle

### 4. Help Text

```
Usage: aof daemon [command] [options]

Daemon management commands

Commands:
  start [options]    Start the AOF daemon in background
  stop [options]     Stop the running daemon
  status             Check daemon status
  restart [options]  Restart the daemon

Options:
  -h, --help         Display help for command

Examples:
  $ aof daemon start --port 18001
  $ aof daemon status
  $ aof daemon stop
  $ aof daemon restart
```

## Acceptance Criteria

- [ ] `aof daemon start` successfully forks daemon and exits
- [ ] Daemon process stays alive after CLI exits
- [ ] PID file created at correct location
- [ ] `aof daemon status` reports accurate state
- [ ] `aof daemon stop` gracefully terminates daemon
- [ ] `aof daemon restart` works end-to-end
- [ ] All error cases handled with clear messages
- [ ] Unit tests pass
- [ ] Integration test: start → verify running → stop → verify stopped
- [ ] Help text accurate and helpful

## Dependencies

- AOF-doi (Daemon PID lock) — **CLOSED** ✅

## Testing Locally

```bash
# Build
npm run build

# Start daemon
node dist/cli/index.js daemon start --port 18001

# Check status
node dist/cli/index.js daemon status

# Stop daemon
node dist/cli/index.js daemon stop
```

## Notes

- **This is a P1 blocker** — Mule experiment cannot proceed without this
- The daemon core logic is solid (already tested)
- This is pure CLI wiring work
- Should be ~1-2 hours of focused work

## Questions?

If you hit any blockers, check:
1. `src/daemon/index.ts` for public API
2. Existing CLI command structure in `src/cli/commands/`
3. Commander.js docs for subcommand patterns

Report back when done or if you need clarification.
