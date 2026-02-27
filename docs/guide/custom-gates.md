---
title: "Writing Custom Workflow Gates"
description: "Design workflow gates for your specific process — from simple reviews to complex multi-stage pipelines."
---

Workflow gates are domain-neutral — the same primitive works for software development, sales pipelines, content review, compliance workflows, or any staged process. This guide walks you through designing gates for your specific use case.

## Anatomy of a Workflow

```yaml
workflow:
  name: my-workflow              # Unique identifier (referenced in task routing.workflow)
  rejectionStrategy: origin      # Where rejected tasks loop back to

  gates:
    - id: first-gate
      role: some-role
      # ...

  outcomes:
    complete: advance
    needs_review: reject
    blocked: hold
```

### Rejection Strategies

| Strategy | Description |
|----------|-------------|
| `origin` | Always loop back to the first gate (most predictable) |

Currently, `origin` is the only supported strategy. Future versions will add `previous` (loop to the immediately-preceding gate).

---

## Pattern 1: Simple Review (2 Gates)

The minimal workflow. Implement → review cycle.

```yaml
workflow:
  name: simple-review
  rejectionStrategy: origin

  gates:
    - id: implement
      role: developer
      description: "Build the feature"
      timeout: 4h

    - id: review
      role: reviewer
      canReject: true
      description: "Review and approve"
      timeout: 2h
      escalateTo: tech-lead
```

**Use when:** Small teams, quick iteration, basic quality control.

---

## Pattern 2: Full SDLC (4–5 Gates)

A complete engineering pipeline with QA and product approval.

```yaml
workflow:
  name: full-sdlc
  rejectionStrategy: origin

  gates:
    - id: implement
      role: developer
      timeout: 4h
      escalateTo: architect

    - id: code-review
      role: architect
      canReject: true
      timeout: 2h

    - id: qa
      role: qa
      canReject: true
      timeout: 3h

    - id: po-approval
      role: po
      canReject: true
      timeout: 24h
      escalateTo: vp
```

---

## Pattern 3: Conditional Gates

Gates that only activate for certain task types. Use `condition.anyTag` to filter:

```yaml
workflow:
  name: conditional-sdlc
  rejectionStrategy: origin

  gates:
    - id: implement
      role: developer
      timeout: 4h

    - id: security-review
      role: security
      canReject: true
      description: "Security audit — only for auth/API changes"
      condition:
        anyTag: [security, auth, api, payment]
      timeout: 4h

    - id: docs-review
      role: technical-writer
      canReject: true
      description: "Documentation review — only for public-facing changes"
      condition:
        anyTag: [public-api, docs, breaking-change]
      timeout: 2h

    - id: final-review
      role: reviewer
      canReject: true
      timeout: 2h
```

Tasks tagged with `[typescript, auth]` would go through `implement → security-review → final-review`, skipping `docs-review`.

---

## Pattern 4: Domain-Neutral (Sales Pipeline)

Gates are not limited to software. Here's a sales pipeline:

```yaml
workflow:
  name: sales-pipeline
  rejectionStrategy: origin

  gates:
    - id: qualify
      role: bdr
      description: "Qualify the lead (BANT)"
      timeout: 24h
      escalateTo: sales-manager

    - id: propose
      role: ae
      canReject: true
      description: "Create proposal and pricing"
      timeout: 48h

    - id: negotiate
      role: ae
      canReject: true
      description: "Contract negotiation"
      timeout: 72h

    - id: legal-review
      role: legal
      canReject: true
      description: "Legal review (enterprise deals only)"
      condition:
        anyTag: [enterprise, contract]
      timeout: 48h
      escalateTo: general-counsel

    - id: close
      role: vp-sales
      canReject: true
      description: "Final sign-off to close the deal"
      timeout: 24h
```

---

## Designing Your Roles

Every gate's `role` must be defined in your org chart's `roles` section:

```yaml
# org/org-chart.yaml
roles:
  developer:
    agents: [swe-backend, swe-frontend]
    description: "Implements features"

  reviewer:
    agents: [swe-architect]
    description: "Reviews code quality"

  qa:
    agents: [swe-qa]
    description: "Quality assurance"

  po:
    agents: [product-owner]
    description: "Product owner sign-off"
    requireHuman: true    # Must be a human agent
```

**Tips:**
- Keep roles abstract (not agent-specific) — this lets you rotate agents without changing workflows
- Use `requireHuman: true` for gates that need human judgment (final approvals, security reviews)
- One agent can serve multiple roles (a tech lead can be both `reviewer` and `architect`)

---

## Timeout and Escalation Design

Every gate should have a timeout with an escalation path:

```yaml
- id: code-review
  role: reviewer
  canReject: true
  timeout: 2h                  # Auto-escalate after 2 hours
  escalateTo: tech-lead        # Who gets the task when timeout fires
```

**Timeout format:** `Nh` for hours, `Nm` for minutes, `Ns` for seconds.

**Escalation behavior:**
1. Gate exceeds its timeout duration
2. `gate.timeout` event emitted
3. Task re-routed to `escalateTo` role
4. Notification sent to escalation target

---

## Testing Your Workflow

Before deploying, validate the workflow against your org chart:

```bash
aof org validate
# ✅ Org chart valid: 5 agents, 2 teams, 4 roles
# ✅ Workflow 'swe-sdlc': all gate roles defined in org chart

aof org lint
# Checking referential integrity...
# ✅ All role references resolved
```

Then test with a simple task:

```bash
# Create a test task with your workflow
aof task create "Test workflow routing" --workflow my-workflow

# Check it's routed to the correct first gate
aof task show TASK-2026-02-21-001
# gate.current: implement
# routing.agent: swe-backend  (resolved from 'developer' role)

# Simulate completion
# (Use aof_task_complete with appropriate callerRole in agent tests)
```

---

## Complete Org Chart + Workflow Example

```yaml
# org/org-chart.yaml
schemaVersion: 1

agents:
  - id: swe-backend
    name: Backend Engineer
    active: true
    capabilities:
      tags: [typescript, nodejs]
    comms:
      preferred: send
      sessionKey: "agent:main:swe-backend"

  - id: swe-architect
    name: Architect
    active: true
    capabilities:
      tags: [architecture, review]
    comms:
      preferred: send
      sessionKey: "agent:main:swe-architect"

  - id: swe-qa
    name: QA Engineer
    active: true
    comms:
      preferred: send
      sessionKey: "agent:main:swe-qa"

teams:
  - id: engineering
    name: Engineering
    lead: swe-architect

roles:
  developer:
    agents: [swe-backend]
    description: "Implements features and fixes"

  reviewer:
    agents: [swe-architect]
    description: "Architecture and code quality review"

  qa:
    agents: [swe-qa]
    description: "Quality assurance"
```

```yaml
# org/workflows/standard.yaml
workflow:
  name: standard
  rejectionStrategy: origin

  gates:
    - id: implement
      role: developer
      description: "Implement the feature with tests"
      timeout: 4h
      escalateTo: reviewer

    - id: review
      role: reviewer
      canReject: true
      description: "Code quality and architecture review"
      timeout: 2h

    - id: qa
      role: qa
      canReject: true
      description: "Integration testing and acceptance criteria"
      timeout: 3h
```

> **Tip:** See the example workflows in `docs/examples/` for more complete templates including the full 9-gate SWE SDLC and the sales pipeline.
