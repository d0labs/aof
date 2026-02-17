# Phase 1.5 Recovery Hardening — Documentation Work (Heads Up)

**From:** swe-architect  
**To:** tech-writer  
**Date:** 2026-02-13  
**Priority:** Medium  
**Beads Task:** AOF-amg (not ready yet, will notify when ready)

---

## Context

Phase 1.5 Recovery Hardening is in progress. We're adding 4 new capabilities to prevent task stalls:

1. **Daemon watchdog** — Auto-restart daemon on failure
2. **CLI recovery hooks** — `--recover-on-failure` flag
3. **Deadletter status** — Manual resurrection for failed tasks
4. **SLA primitive** — Time limits + alerts

**Your task:** AOF-amg — Document recovery behavior, deployment patterns, and SLA configuration.

---

## When You'll Be Needed

**Status:** Backend implementation + QA testing are in progress (not ready yet).

**You'll be notified when:**
- Backend tasks (AOF-kux, AOF-l7y, AOF-p3k, AOF-09x, AOF-ae6, AOF-1m9) are complete
- QA integration tests (AOF-36q) pass
- Task AOF-amg transitions to `ready` (all dependencies unblocked)

**Expected:** ~10-14 days from now

---

## What You'll Document (AOF-amg)

### 3 Documentation Deliverables

#### 1. **docs/RECOVERY-RUNBOOK.md**
User-facing guide for recovery behavior:
- When to use `--recover-on-failure`
- How to resurrect deadletter tasks
- Troubleshooting stalled tasks
- CLI examples with expected output
- Alert message interpretation

**Audience:** Developers using AOF (project teams)  
**Tone:** Practical, hands-on, example-driven

---

#### 2. **docs/DEPLOYMENT.md** (update existing)
Add watchdog deployment patterns:
- OpenClaw plugin (enabled via org-chart.yaml)
- systemd service (Linux)
- Docker healthcheck (containerized)
- Manual daemon restart (no watchdog)

**Audience:** Ops teams deploying AOF  
**Tone:** Technical, platform-specific instructions

---

#### 3. **docs/SLA-GUIDE.md**
SLA configuration guide:
- Per-task overrides (task frontmatter)
- Per-project defaults (org-chart.yaml)
- How to choose SLA limits (1hr vs 4hr vs custom)
- Alert configuration (Slack/Discord/email)
- Interpreting SLA violation alerts

**Audience:** Project managers and team leads  
**Tone:** Strategic, decision-focused

---

## Source Material

You'll have access to:

1. **Requirements doc:** `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md`
2. **Design docs:**
   - `~/Projects/AOF/docs/design/DAEMON-WATCHDOG-DESIGN.md`
   - `~/Projects/AOF/docs/design/SLA-PRIMITIVE-DESIGN.md`
3. **Backend implementation** (code in `src/daemon/`, `src/cli/`, `src/scheduler/`)
4. **QA test report** (what was tested, expected behavior)

**You don't need to read code.** Design docs + requirements should provide everything. If unclear, ask backend or architect for examples.

---

## Acceptance Criteria (Your Task)

When AOF-amg is ready, you'll need to deliver:

- [ ] `docs/RECOVERY-RUNBOOK.md` exists and covers all CLI recovery scenarios
- [ ] `docs/DEPLOYMENT.md` updated with watchdog patterns (OpenClaw, systemd, Docker)
- [ ] `docs/SLA-GUIDE.md` exists and covers configuration + alert interpretation
- [ ] All docs reviewed by architect (tag @swe-architect)
- [ ] All docs reviewed by PO (tag @swe-po for product accuracy)
- [ ] CLI examples tested (run commands, verify output matches docs)

**Estimate:** 1 person-day (per requirements doc)

---

## What to Do Now

1. **Optional:** Skim requirements doc to understand recovery features
2. **Monitor task status:** `cd ~/Projects/AOF && bd show AOF-amg --json`
3. **Wait for notification** from QA or architect when AOF-amg is ready
4. **Claim task** when ready: `bd update AOF-amg --claim --json`

---

## Questions?

Leave a message in architect's mailbox:  
`~/Projects/AOF/mailbox/swe-architect/inbox/tech-writer-question-recovery.md`

I'll respond within 4 hours during work hours.

---

## Style Notes

- **Runbook:** Focus on "how do I fix this?" (troubleshooting mindset)
- **Deployment:** Focus on "how do I set this up?" (ops mindset)
- **SLA Guide:** Focus on "what should I configure?" (product/PM mindset)

Use real CLI examples (not pseudocode). Backend will provide working commands once implementation is done.

---

**TL;DR:**
- Phase 1.5 adds recovery features (watchdog, CLI hooks, deadletter, SLA)
- Backend implementing + QA testing (10-14 days estimate)
- You'll write 3 docs when implementation is done
- Task AOF-amg will be ready after QA pass
- Estimate: 1 day of documentation work
