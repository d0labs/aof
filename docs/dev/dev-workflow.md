---
title: "AOF Development Workflow"
description: "Fast-feedback development loop for AOF contributors."
---

A practical guide to the fast-feedback loop used by AOF contributors.

---

## Goals

- **<60s iteration** for most changes: edit → targeted test → feedback
- **Test-gated task completion**: no change ships without tests
- **Trunk-based development**: small, focused commits to `main`

---

## Roles

| Role | Responsibility |
|---|---|
| `swe-architect` | Orchestrates, assigns work, owns checkpoints |
| `swe-backend` | Implements scheduler/dispatch changes, adds tests (TDD) |
| `swe-qa` | Runs full and targeted tests, validates state transitions |

**Sequential work rule:** one agent writes to the codebase at a time. Use a simple lock file:

```
~/Projects/AOF/.agent-lock
```

Contents: `agent=<id> | task=<id> | started=<timestamp>`

Remove when done.

---

## Fast Iteration Loop (Target <60s)

From the project root:

1. Edit code
2. Run targeted test:
   ```bash
   npx vitest run src/path/to/__tests__/my-feature.test.ts
   ```
3. Fix → re-run until green
4. Optional watch mode:
   ```bash
   npx vitest src/path/to/__tests__/my-feature.test.ts --watch
   ```

**Rule:** every behavior change gets a new or updated test first (TDD).

---

## Full Test Gate (Required Before "Done")

```bash
npm test
```

All tests must be green before moving a task to `done/`.

---

## QA Handoff

1. **Backend** finishes change + targeted tests → moves task to `review/` and notifies architect
2. **Architect** assigns QA run
3. **QA** runs targeted and/or full suite; reports results (pass/fail + repro notes)
4. Task moves to `done/` only after QA sign-off

---

## Smoke Test Checklist (AOF Plugin)

After deploying AOF as an OpenClaw plugin:

1. Confirm tasks are visible:
   ```bash
   ls ~/.openclaw/aof/tasks/ready/
   ```
2. Verify scheduler events are flowing:
   ```bash
   tail -n 50 ~/.openclaw/aof/events/events.jsonl
   ```
3. Dispatch a smoke-test task and confirm the full lifecycle:
   ```
   ready → in-progress → done
   ```

If tasks stay in `ready` with `reason: no_executor`, the spawnAgent API is unavailable — check plugin configuration.

---

## Checkpoints

Take a checkpoint after:
- Completing a risky change
- Before a large refactor
- After a smoke test passes

```bash
CHECKPOINT="checkpoint-$(date +%Y%m%d-%H%M%S)-description"
mkdir -p ~/backups/$CHECKPOINT

# Save OpenClaw state
tar czf ~/backups/$CHECKPOINT/openclaw-state.tar.gz \
  --exclude='.openclaw/sessions' \
  --exclude='.openclaw/cache' \
  --exclude='.openclaw/logs' \
  -C ~ .openclaw/

# Save AOF project
tar czf ~/backups/$CHECKPOINT/AOF.tar.gz -C ~/Projects AOF

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) - $CHECKPOINT" >> ~/backups/CHECKPOINT-LOG.txt
```

---

## Rollback

```bash
bash ~/backups/restore.sh ~/backups/<checkpoint-name>
```

Validate with:

```bash
cd ~/Projects/AOF && npm test
```

---

## Ground Rules

- No parallel agents writing to the same workspace
- Tests gate task completion — no exceptions
- Checkpoints are required at milestones
- Keep commits small and descriptive (see [CONTRIBUTING.md](../../CONTRIBUTING.md))
