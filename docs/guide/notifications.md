# Notification Policy (P2.4)

**Status:** Specification complete; Matrix integration deferred to Phase 3.

---

## Objective

Define deterministic notification rules for AOF → Matrix to ensure operator awareness without spam.

---

## Notification Rules

### Task State Transitions

| Event | Condition | Channel | Template |
|-------|-----------|---------|----------|
| `task.assigned` | Task moved backlog → ready | `#aof-dispatch` | `📬 Task {id} assigned to {agent}: {title}` |
| `task.started` | Lease acquired | `#aof-dispatch` | `▶️ {agent} started {id}: {title}` |
| `task.completed` | Task → done | `#aof-dispatch` | `✅ {agent} completed {id}: {title}` |
| `task.review` | Task → review | `#aof-review` | `👀 {id} ready for review: {title} (by {agent})` |
| `task.blocked` | Task → blocked | `#aof-alerts` | `🚧 {id} blocked: {title} ({reason})` |

### Recovery & Staleness

| Event | Condition | Channel | Template |
|-------|-----------|---------|----------|
| `heartbeat.stale` | Heartbeat expired | `#aof-alerts` | `⚠️ Stale heartbeat on {id}: {title} (agent: {agent}, last: {lastBeat})` |
| `lease.expired` | Lease TTL exceeded | `#aof-alerts` | `⏰ Lease expired on {id}: {title} (agent: {agent})` |
| `task.abandoned` | Run artifact indicates crash | `#aof-alerts` | `💀 Task {id} may be abandoned: {title} (check run.json)` |

### Drift & Config

| Event | Condition | Channel | Template |
|-------|-----------|---------|----------|
| `drift.detected` | Org chart ≠ OpenClaw agents | `#aof-alerts` | `⚠️ Org chart drift: {summary}` |
| `memory.drift` | Memory config ≠ org chart policy | `#aof-alerts` | `⚠️ Memory config drift: {summary}` |
| `config.invalid` | Config validation failed | `#aof-alerts` | `❌ Invalid config: {error}` |

### Health & Metrics

| Event | Condition | Channel | Template |
|-------|-----------|---------|----------|
| `scheduler.down` | Poll failures >3 consecutive | `#aof-critical` | `🔴 Scheduler down: {lastError}` |
| `scheduler.recovered` | Polls resume after failure | `#aof-alerts` | `🟢 Scheduler recovered` |
| `metrics.anomaly` | Queue depth >20 for >10min | `#aof-alerts` | `📊 Metrics anomaly: {metric} = {value}` |

---

## Dedupe Logic

### Rule: 5-Minute Window per (Task, Event Type)

**Behavior:**
- Track last notification timestamp per `(taskId, eventType)` tuple.
- Suppress duplicate notifications within 5min window.
- Exception: Critical alerts (`scheduler.down`, `task.abandoned`) are **never** suppressed.

**Implementation:**
```typescript
interface DedupeKey {
  taskId?: string;
  eventType: string;
}

class NotificationDeduper {
  private lastSent = new Map<string, number>(); // key → timestamp
  private readonly ttlMs = 300_000; // 5min

  shouldSend(key: DedupeKey): boolean {
    const keyStr = `${key.taskId ?? "global"}:${key.eventType}`;
    const last = this.lastSent.get(keyStr) ?? 0;
    const now = Date.now();

    if (now - last < this.ttlMs) {
      return false; // Suppressed
    }

    this.lastSent.set(keyStr, now);
    return true;
  }
}
```

---

## Channel Selection

### Channel Hierarchy

1. **`#aof-critical`** — Scheduler down, system-level failures.
2. **`#aof-alerts`** — Staleness, drift, recovery events.
3. **`#aof-review`** — Tasks awaiting human review.
4. **`#aof-dispatch`** — Normal task state changes.

### Routing Rules

- **Critical**: Immediate operator intervention required.
- **Alerts**: Action needed within 1 hour.
- **Review**: Action needed within 1 business day.
- **Dispatch**: Informational (no action required).

---

## Matrix Integration (Phase 3)

### API Surface

```typescript
interface MatrixNotifier {
  send(channel: string, message: string): Promise<void>;
  sendWithReaction(channel: string, message: string, emoji: string): Promise<void>;
}
```

### Implementation Strategy

1. Use OpenClaw `message` tool for Matrix send.
2. Wrap in `MatrixNotifier` adapter with retry logic.
3. Wire into `EventLogger.on("event", ...)` → filter → dedupe → send.
4. Add `aof notifications test` CLI command for dry-run validation.

---

## Testing Strategy

### Unit Tests

- Dedupe logic (within window, outside window, critical override)
- Channel selection (event type → channel mapping)
- Template rendering (variable substitution)

### Integration Tests

- Mock Matrix client
- Emit test events
- Assert notifications sent to correct channels
- Assert dedupe behavior

### Acceptance Tests

- Live Matrix integration (sandbox channel)
- Emit full lifecycle: assign → start → complete
- Verify correct notifications + no spam

---

## Open Questions (for Phase 3)

1. Should `#aof-dispatch` be opt-in per agent? (High-volume agents may spam.)
2. Should notifications include links to web UI? (Not yet implemented.)
3. Should we support @mentions for urgent alerts? (Security/spam concerns.)
4. Should we aggregate "batch" notifications? (e.g., "5 tasks completed in last hour")

---

## Acceptance Criteria (P2.4)

- [x] Notification policy documented (this file)
- [x] Dedupe rules specified
- [x] Channel selection rules specified
- [ ] Matrix integration implemented (deferred to Phase 3)
- [ ] Tests for dedupe logic (deferred to Phase 3)
- [ ] CLI command for notification testing (deferred to Phase 3)

**Rationale for deferral:**
Core AOF orchestration (P2.1-P2.3) is complete and tested (216 tests). Notifications are important but separable. Implementing Matrix integration now would:
1. Add external dependency (Matrix API)
2. Require additional integration testing
3. Risk scope creep (notification UX, threading, reactions, etc.)

By documenting the policy now, we ensure future implementation stays deterministic and spam-free.

---

## Next Steps (Phase 3)

1. Implement `MatrixNotifier` adapter
2. Wire into `EventLogger` with dedupe
3. Add CLI command: `aof notifications test --dry-run`
4. Integration tests with mock Matrix
5. Smoke test in live Matrix (sandbox channel)
