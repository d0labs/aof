# CRITICAL: Core Design Requirements from Xav

**From:** Demerzel  
**Date:** 2026-02-16 22:45 EST  
**Priority:** MUST-HAVE — These are non-negotiable design constraints

---

## Requirement 1: Dumb Agents Must Thrive

**The bar:** An agent with minimal training and modest capability (e.g., qwen3-coder:30b, no fine-tuning, no AOF-specific instructions) should get **a ton of value** out of AOF out of the box.

**What this means for design:**

1. **Highly intuitive interfaces.** If an agent needs to read documentation to figure out how to complete a task, the interface has failed. `aof_task_complete` should be so obvious from the tool description alone that any agent can use it correctly on first encounter.

2. **Proper harness and scaffolding.** AOF provides the structure — the agent just fills in the work. The task tells the agent exactly what to do, the tool tells the agent exactly how to signal completion, and AOF handles everything else. The agent is never left guessing "what do I do next?"

3. **Guardrails.** If an agent does something wrong (invalid outcome, missing fields, completing someone else's task), AOF catches it and provides a clear, actionable error — not a silent failure or cryptic crash.

4. **Self-documenting config.** Config files (project.yaml, workflow definitions, org charts) should be readable and understandable without external documentation. Comments, clear naming, sensible defaults.

5. **Teaching without polluting context.** AOF needs a way to help agents understand how to use it idiomatically WITHOUT injecting walls of instructions into their system prompt. Ideas:
   - Tool descriptions that teach usage patterns (the tool IS the documentation)
   - Task frontmatter that includes "here's what's expected of you at this gate" inline
   - Error messages that guide correct behavior ("You returned 'medium' priority, valid values are: critical, high, normal, low")
   - A lightweight "AOF cheatsheet" that can be injected only when needed (not always)

**The spectrum:**
- **Dumb agent (no AOF training):** Gets clear tasks, obvious tools, helpful errors. Produces work. Maybe doesn't use advanced features. Still valuable.
- **Trained agent (AOF-aware):** Leverages full protocol, writes richer completion reports, uses metadata effectively. Naturally does a better job.
- **Both must work.** The system optimizes for the dumb case and rewards the smart case.

**Anti-pattern to avoid:** "The agent needs to read a 2000-line SKILL.md to understand how to interact with AOF." If that's the case, the design has failed.

---

## Requirement 2: Executable Test Specs in Frontmatter (Wishlist → V2)

**Current decision:** BDD-style structured acceptance criteria in task frontmatter (not full Gherkin).

**Enhancement (design for it now, build later):** The frontmatter test specs should be designed so they're actually runnable — not just structured documentation. Example:

```yaml
tests:
  - given: "User submits valid credentials"
    when: "POST /auth/login"
    then:
      status: 200
      body_contains: ["token", "expiresIn"]
  - given: "User submits expired token"
    when: "GET /api/protected"
    headers: { Authorization: "Bearer {{expired_token}}" }
    then:
      status: 401
      body_contains: ["token expired"]
```

**Value:** AOF or a QA gate could auto-generate test stubs from this, or validate implementation mechanically. The spec IS the test contract.

**For now:** Design the frontmatter schema with executability in mind. Don't build the runner yet, but don't paint into a corner either.

---

## Action Required

These requirements must be reflected in:
1. **WORKFLOW-GATES-DESIGN.md** — agent interface section, error handling section
2. **AGENTIC-SDLC-DESIGN.md** — task structure, gate descriptions
3. **PM addendum** — how PM ensures tasks are "dumb-agent-ready"
4. **All tool descriptions** in the AOF plugin — they should teach usage, not just describe parameters

Please confirm these constraints are understood and will be incorporated into the next revision of the design docs.
