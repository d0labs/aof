# CRITICAL: Core Design Requirements from Xav

**From:** Demerzel  
**Date:** 2026-02-16 22:45 EST  
**Priority:** MUST-HAVE — Non-negotiable design constraints for Workflow Gates

---

## Requirement: Dumb Agents Must Thrive

**The bar:** An agent with minimal training and modest capability (qwen3-coder:30b, no fine-tuning, no AOF-specific instructions) must get **a ton of value** from AOF out of the box.

**Design implications for your architecture:**

### 1. Tool Descriptions ARE Documentation
The `aof_task_complete` tool description must be so clear that any agent uses it correctly on first encounter. No external docs needed. The tool teaches its own usage.

```typescript
// BAD: Agent needs to know about gates, outcomes, etc.
description: "Signal task completion with gate-aware outcome routing"

// GOOD: Agent knows exactly what to do
description: "Mark your current task as done. Set outcome to 'complete' if your work is finished, 'needs_review' if you found problems that need someone else to fix, or 'blocked' if you can't proceed. Include a summary of what you did."
```

### 2. Task Context Teaches the Gate
When AOF assigns a task at a gate, the task itself should tell the agent what's expected — inline, not via external reference:

```yaml
# Injected by AOF when routing to code-review gate:
gate_context:
  role: "You are reviewing this code for quality and architecture compliance."
  checklist:
    - "Were tests written before implementation? (Check git timestamps)"
    - "Is test coverage >= 80% for new code?"
    - "Are there files > 500 LOC or functions > 120 LOC?"
  outcomes:
    complete: "Code passes review. It will advance to QA."
    needs_review: "Code needs fixes. List specific blockers. It will go back to the implementer."
```

The agent doesn't need to know it's at a "gate" or what gates are. It just sees: "here's your job, here's the checklist, here's how to signal done."

### 3. Guardrails with Helpful Errors
Every invalid action produces an actionable error, not a silent failure:

- Invalid outcome → "You returned 'done'. Valid outcomes: complete, needs_review, blocked"
- Missing summary → "Please include a summary of what you did"
- Wrong task → "You're trying to complete task X but you're assigned to task Y"
- Invalid priority → "Priority 'medium' is not valid. Use: critical, high, normal, low"

### 4. Self-Documenting Config
project.yaml should be readable without docs:

```yaml
# Workflow defines the stages every task goes through.
# Each gate is a checkpoint — tasks advance automatically when agents complete work.
workflow:
  name: default
  
  # How far to send tasks back when a reviewer rejects:
  # "previous" = one step back, "origin" = back to start
  rejectionStrategy: previous
  
  gates:
    # First gate: someone builds the thing
    - id: implement
      role: backend  # Which team role handles this (mapped in org.yaml)
      
    # Second gate: architect checks quality
    - id: review
      role: architect
      canReject: true  # Can send task back to implement with feedback
```

### 5. Teaching Without Context Pollution
AOF needs a mechanism to help agents use it idiomatically WITHOUT injecting walls of text into system prompts. Options to design for:

- **Tool descriptions that teach** (primary — always available, zero cost)
- **Gate context injected per-task** (secondary — only when relevant)
- **Error messages that guide** (tertiary — only on mistakes)
- **Lightweight cheatsheet** (optional — injected only when agent seems confused, e.g., after 2+ errors)

### 6. The Spectrum
- **Dumb agent:** Gets clear tasks, obvious tools, helpful errors. Works. Produces value.
- **Trained agent:** Uses advanced features, writes rich reports, leverages metadata. Naturally better.
- **Both must work.** System optimizes for dumb, rewards smart.

**Anti-pattern:** If an agent needs to read a SKILL.md to interact with AOF, the design has failed.

---

## Executable Test Specs (Design For, Build Later)

Design the task frontmatter test schema so specs are runnable — not just structured AC:

```yaml
tests:
  - given: "User submits valid credentials"
    when: "POST /auth/login"
    then:
      status: 200
      body_contains: ["token", "expiresIn"]
```

Don't build the test runner yet, but make sure the schema doesn't prevent future executability.

---

## Action
Incorporate these constraints into the next revision of WORKFLOW-GATES-DESIGN.md. Especially:
- Section 4 (Agent Interface) — rewrite with dumb-agent-first principle
- Section 9 (Edge Cases) — every error must be helpful and actionable
- Tool registration code — descriptions teach usage, not just describe params
- Config examples — add inline comments, make self-documenting
