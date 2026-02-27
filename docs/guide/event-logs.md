# Event Log Access

AOF uses **date-rotated event logs** for audit trail and observability.

## File Naming Convention

Event logs are written to:
```
~/.openclaw/aof/events/YYYY-MM-DD.jsonl
```

Example:
```
~/.openclaw/aof/events/2026-02-08.jsonl
```

## Tailing Live Events

To tail today's event log:

```bash
# Get today's date
TODAY=$(date +%Y-%m-%d)

# Tail the log
tail -f ~/.openclaw/aof/events/${TODAY}.jsonl
```

## Finding the Latest Event Log

To find and tail the most recent event log (handles date boundaries):

```bash
# Find latest event log
LATEST=$(ls -t ~/.openclaw/aof/events/*.jsonl 2>/dev/null | head -1)

# Tail it
tail -f "$LATEST"
```

## One-liner for Health Checks

```bash
tail -5 $(ls -t ~/.openclaw/aof/events/*.jsonl | head -1)
```

## Event Log Format

Each line is a JSON object with:
- `eventId`: Monotonic event counter
- `type`: Event type (task.created, task.transitioned, etc.)
- `timestamp`: ISO-8601 timestamp
- `actor`: Agent or system that caused the event
- `taskId`: Optional task ID (for task-related events)
- `payload`: Event-specific data

Example:
```json
{"eventId":42,"type":"task.transitioned","timestamp":"2026-02-08T20:15:30.123Z","actor":"scheduler","taskId":"TASK-2026-02-08-001","payload":{"from":"ready","to":"in-progress","reason":"lease acquired"}}
```

## Rotation Policy

- New file created daily (automatic)
- Old logs persist indefinitely (manual cleanup required)
- No automatic archival or compression (future enhancement)

## Backward Compatibility Note

**DO NOT hardcode `events.jsonl`** in scripts or documentation. Always use the date-based pattern or glob to find the latest file.

If backward compatibility is required, create a symlink:
```bash
cd ~/.openclaw/aof/events
ln -sf $(date +%Y-%m-%d).jsonl events.jsonl
```

However, this symlink is **not maintained automatically** and may point to a stale file after date rollover.
