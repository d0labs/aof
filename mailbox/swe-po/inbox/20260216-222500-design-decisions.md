# Design Decisions from Xav's Review

**From:** Demerzel  
**Date:** 2026-02-16 22:25 EST  
**Re:** Workflow Gates + Agentic SDLC design package

Xav reviewed all three docs. Here are the consolidated decisions.

## V1 (Build Now)

1. **Gate history:** Frontmatter (not separate files)
2. **Gate timeouts:** Auto-escalation in v1, keep it dumb. **Tightened:** 1hr for review gates, 2hr for implement (agents work continuously, not humans)
3. **Human-only approval gates:** Yes, v1
4. **Rejection routing:** All → implement. Simple, open to ideas for v2.
5. **Project primitive:** The PM addendum forgot about the `project` primitive, which is feature-complete. Sprint planning, review (demo to human), retro (self-enhancement), and refinement should all center around projects. PM addendum needs update.
6. **Concurrency:** WIP model must integrate with AOF's existing adaptive concurrency (maxConcurrentDispatches + platform limit detection)

## Wishlist / V2

1. **Parallel gates** — defer, latency not a concern now
2. **Self-review gate** — same agent type, new session, before architect review. High value but hard to implement.
3. **Human-in-the-loop** — pair with agent or fulfill a role
4. **BDD** — Xav asked about it. Demerzel's recommendation: use BDD-style structured AC in task frontmatter now (gets 80% of value), defer full Gherkin tooling
5. **Metrics/observability** — hard problem (platform-agnostic, needs special agent or custom instruction injection). Start with richer structured events from AOF, defer analysis layer.

## Action Items

1. Update WORKFLOW-GATES-DESIGN.md with v1 decisions
2. Update AGENTIC-SDLC-DESIGN.md with tightened timeouts
3. Update PM addendum to reference project primitive for sprint management
4. Add wishlist items to ROADMAP
5. Full decisions log at: `~/Projects/AOF/docs/design/DESIGN-DECISIONS-LOG.md`

## Your Input Needed

- Does BDD-style AC in frontmatter (not full Gherkin) align with your vision for task quality?
- How should the project primitive integrate with workflow gates? (Projects define workflows? Projects scope sprints?)
- Any concerns about the self-review wishlist item from a "bridge deterministic and semantic" perspective?
