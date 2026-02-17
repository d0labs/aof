# Workflow Gates: User Guide

**Version:** 1.0  
**Last Updated:** 2026-02-16

---

## Overview

**Workflow Gates** is AOF's primitive for enforcing multi-stage processes with review checkpoints, rejection loops, and conditional progression. It enables you to define deterministic workflows (implement → review → test → approve) that automatically route work through your organization.

### What Are Workflow Gates?

A **gate** is a checkpoint in your workflow where a specific role must review, validate, or approve work before a task can proceed. Think of gates as quality control points in an assembly line:

- **Implementation gate**: Developer builds the feature
- **Review gate**: Architect checks code quality
- **QA gate**: QA engineer tests functionality
- **Approval gate**: Product Owner signs off

When a task reaches a gate, AOF automatically routes it to agents with the appropriate role. When the agent completes their work, the task advances to the next gate — or loops back for revisions if rejected.

### Key Benefits

- **Deterministic routing**: No ambiguity about "who does what next"
- **Automatic enforcement**: Agents can't skip gates or bypass reviews
- **Rejection loops**: Reviewers can send work back with specific feedback
- **Conditional logic**: Gates activate based on task metadata (e.g., security review only for auth changes)
- **Timeout enforcement**: SLA tracking with automatic escalation when gates stall
- **Full auditability**: Every gate transition is logged in task history
- **Domain-neutral**: Works for software, sales, content, compliance — any staged process

---

## Quick Start: Your First Workflow

Let's create a minimal 2-gate workflow: implement → review.

### Step 1: Define the Workflow

Create `project.yaml` in your project root:

```yaml
workflow:
  name: simple-review
  rejectionStrategy: origin
  gates:
    - id: implement
      role: developer
      description: "Implement the feature with tests"
    
    - id: review
      role: reviewer
      canReject: true
      description: "Review code quality and correctness"
  
  outcomes:
    complete: advance
    needs_review: reject
```

### Step 2: Define Roles in Org Chart

Create `org.yaml` (or add to existing):

```yaml
schemaVersion: 1
agents:
  - id: dev-1
    name: "Developer Agent"
    active: true
  - id: reviewer-1
    name: "Reviewer Agent"
    active: true

roles:
  developer:
    agents: [dev-1]
    description: "Implements features and fixes"
  reviewer:
    agents: [reviewer-1]
    description: "Reviews code quality"
```

### Step 3: Create a Task

Create a task file with the workflow reference:

```yaml
---
id: AOF-abc
title: "Add user authentication"
status: ready
routing:
  workflow: simple-review
  role: developer
gate:
  current: implement
  entered: 2026-02-16T10:00:00Z
---

# Task Description
Implement JWT-based authentication for the API.

## Acceptance Criteria
- [ ] JWT middleware validates tokens
- [ ] Tests cover token validation
- [ ] Error handling for expired tokens
```

### Step 4: Complete the Task

When the developer finishes, they mark the task complete:

```bash
bd complete AOF-abc --json
```

AOF automatically:
1. Updates gate history
2. Advances task to the `review` gate
3. Routes task to agents with `reviewer` role

The reviewer can then approve or reject:

```bash
# Approve (advances to done)
bd complete AOF-abc --json

# OR reject with feedback
bd reject AOF-abc --reason "Missing error handling" --json
```

When rejected, the task loops back to the `implement` gate with feedback attached.

---

## How to Define a Workflow

Workflows are defined in `project.yaml` using a simple YAML schema.

### Basic Structure

```yaml
workflow:
  name: <workflow-name>           # Unique identifier
  rejectionStrategy: origin       # Where rejected tasks loop back (v1: always "origin")
  gates:                          # Ordered list of gates
    - id: <gate-id>               # Unique gate identifier
      role: <role-name>           # Role responsible for this gate
      # ... additional gate properties
  outcomes:                       # Optional semantic mapping
    complete: advance
    needs_review: reject
```

### Workflow Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | Yes | Unique workflow name (referenced in task frontmatter) |
| `rejectionStrategy` | string | No | Where rejected tasks loop back (default: `origin`) |
| `gates` | array | Yes | Ordered list of gates (at least one required) |
| `outcomes` | object | No | Semantic mapping for outcomes (helps agents understand intent) |

---

## Gate Types and Properties

Each gate in your workflow defines a stage where work happens.

### Gate Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | Yes | Unique gate identifier within workflow |
| `role` | string | Yes | Role responsible (must exist in org chart) |
| `canReject` | boolean | No | Whether this gate can send tasks back (default: `false`) |
| `when` | string | No | Conditional expression for gate activation |
| `description` | string | No | Human-readable purpose and acceptance criteria |
| `requireHuman` | boolean | No | Whether only humans can complete (default: `false`) |
| `timeout` | string | No | Max time before escalation (e.g., `"1h"`, `"30m"`) |
| `escalateTo` | string | No | Role to escalate to on timeout |

### Example: Implementation Gate

```yaml
- id: implement
  role: backend
  description: "Implement feature with tests"
  timeout: 2h
  escalateTo: architect
```

### Example: Review Gate with Rejection

```yaml
- id: code-review
  role: architect
  canReject: true
  description: "Review architecture and code quality"
  timeout: 1h
  escalateTo: tech-lead
```

### Example: Human-Only Approval Gate

```yaml
- id: po-approval
  role: po
  requireHuman: true
  description: "Product Owner final sign-off"
  timeout: 4h
  escalateTo: director
```

---

## Gate Outcomes

When agents complete work at a gate, they signal one of three outcomes:

| Outcome | Meaning | Gate Action |
|---------|---------|-------------|
| `complete` | Work done, ready for next stage | Advance to next gate |
| `needs_review` | Work needs revision | Reject to implement gate |
| `blocked` | External blocker | Hold in current gate |

### Complete: Advance to Next Gate

The task proceeds to the next active gate in the workflow. If there are no more gates, the task is marked complete.

```bash
bd complete AOF-abc --json
```

### Needs Review: Rejection Loop

The task loops back to the **implement** gate (first gate in workflow) with feedback attached. The rejecting agent can provide specific blockers and notes:

```bash
bd reject AOF-abc \
  --reason "Implementation needs revision" \
  --blocker "Missing error handling in auth middleware" \
  --blocker "Test coverage at 65%, target is 80%" \
  --json
```

The task's `reviewContext` field is populated with this feedback:

```yaml
gate:
  current: implement
  reviewContext:
    fromGate: code-review
    fromRole: architect
    timestamp: 2026-02-16T15:00:00Z
    blockers:
      - "Missing error handling in auth middleware"
      - "Test coverage at 65%, target is 80%"
    notes: "Please address blockers and resubmit"
```

### Blocked: Hold in Current Gate

The task remains in the current gate but is flagged as blocked. Use this when waiting on external dependencies (customer input, infrastructure, etc.):

```bash
bd block AOF-abc --reason "Waiting on customer API credentials" --json
```

---

## Conditional Gates

Gates can activate conditionally based on task metadata using JavaScript expressions.

### Conditional Syntax

The `when` property accepts JavaScript predicates that evaluate against the task object:

```yaml
- id: security-review
  role: security
  when: "tags.includes('security') || tags.includes('auth')"
  description: "Security audit for sensitive changes"
```

### Available Context

The `when` expression has access to the task object:

- `tags`: Array of task tags
- `metadata`: Object with arbitrary task metadata
- `routing`: Routing information
- `status`: Current task status

### Example: Tag-Based Conditional

```yaml
# Only run QA for non-trivial changes
- id: qa-test
  role: qa
  when: "!tags.includes('skip-qa')"
```

### Example: Metadata-Based Conditional

```yaml
# Only require legal review for high-value deals
- id: legal-review
  role: legal
  when: "metadata.deal_value > 100000"
```

### Example: Multiple Conditions

```yaml
# Only require UX review for frontend changes
- id: ux-review
  role: ux-designer
  when: "tags.includes('ux') || tags.includes('frontend')"
```

### Conditional Gate Behavior

- If a gate's `when` expression evaluates to `false`, the gate is **skipped**
- The task automatically advances to the next gate
- Skipped gates are logged in `gateHistory` for auditability
- If all remaining gates are skipped, the task is marked complete

---

## Timeout and Escalation

Gates can enforce SLA timeouts with automatic escalation to senior roles.

### Why Timeout Enforcement?

- **Prevent bottlenecks**: Detect when tasks are stuck
- **SLA compliance**: Enforce response time commitments
- **Auto-escalation**: Route to senior staff when delays occur
- **Observability**: Track where workflows stall

### Timeout Syntax

```yaml
- id: code-review
  role: architect
  timeout: 1h              # Max 1 hour in this gate
  escalateTo: tech-lead    # Escalate to tech lead on timeout
```

### Duration Format

Timeouts use simple duration strings:

- `"30m"` = 30 minutes
- `"1h"` = 1 hour
- `"2h"` = 2 hours
- `"1d"` = 1 day (24 hours)

### Escalation Behavior

When a task exceeds the timeout threshold:

1. AOF logs a timeout event
2. The task is reassigned to agents with the `escalateTo` role
3. The original assignee is notified
4. A timeout metric is emitted for monitoring

### Example: Multi-Level Escalation

```yaml
gates:
  - id: implement
    role: junior-dev
    timeout: 4h
    escalateTo: senior-dev
  
  - id: senior-review
    role: senior-dev
    timeout: 2h
    escalateTo: tech-lead
  
  - id: final-approval
    role: tech-lead
    timeout: 1h
    escalateTo: director
```

### Timeout Best Practices

- Set realistic timeouts based on historical data
- Escalate to roles with capacity to unblock
- Use shorter timeouts for time-sensitive gates
- Monitor timeout metrics to identify chronic bottlenecks

---

## Org Chart Role Mapping

Workflows reference **roles**, not specific agents. The org chart maps roles to agents.

### Why Role-Based Assignment?

- **Decoupling**: Change agents without changing workflows
- **Load balancing**: Multiple agents can fulfill the same role
- **Rotation**: Rotate on-call reviewers without workflow edits
- **Flexibility**: Add/remove agents as team scales

### Defining Roles in Org Chart

In `org.yaml`:

```yaml
schemaVersion: 1
agents:
  - id: dev-1
    name: "Developer Agent 1"
    active: true
  - id: dev-2
    name: "Developer Agent 2"
    active: true
  - id: reviewer-1
    name: "Reviewer Agent"
    active: true

roles:
  developer:
    agents: [dev-1, dev-2]           # Multiple agents can fulfill role
    description: "Implements features"
  reviewer:
    agents: [reviewer-1]
    description: "Code quality review"
```

### Role Assignment Logic

When a task reaches a gate:

1. AOF looks up the gate's `role` in the org chart
2. Selects an agent from the role's `agents` list (load-balanced)
3. Assigns the task to that agent
4. The agent receives the task in their queue

### Human-Only Roles

Some roles require human involvement (e.g., final approval, compliance sign-off):

```yaml
roles:
  po:
    agents: [po-1]
    requireHuman: true               # Only humans can fulfill
    description: "Product Owner"
```

Gates can also enforce human-only completion:

```yaml
- id: po-approval
  role: po
  requireHuman: true                 # Only humans can complete
```

### Role Validation

AOF validates that:

- All workflow gate roles exist in the org chart
- Each role has at least one active agent
- Escalation roles exist and have agents

Run validation with:

```bash
aof validate workflow --workflow swe-sdlc --org org.yaml
```

---

## Complete Example: SWE SDLC Workflow

Here's a production-grade software development lifecycle workflow.

### Workflow Definition (`project.yaml`)

```yaml
workflow:
  name: swe-sdlc
  rejectionStrategy: origin
  gates:
    - id: implement
      role: backend
      description: "Implement feature with tests"
      timeout: 4h
      escalateTo: architect
    
    - id: code-review
      role: architect
      canReject: true
      description: "Review architecture and code quality"
      timeout: 2h
      escalateTo: tech-lead
    
    - id: qa-test
      role: qa
      canReject: true
      description: "Functional and integration testing"
      when: "!tags.includes('skip-qa')"
      timeout: 3h
      escalateTo: qa-lead
    
    - id: security-review
      role: security
      canReject: true
      description: "Security audit for auth changes"
      when: "tags.includes('security') || tags.includes('auth')"
      timeout: 2h
      escalateTo: security-lead
    
    - id: docs-update
      role: tech-writer
      description: "Update docs for API changes"
      when: "tags.includes('api') || tags.includes('docs')"
      timeout: 2h
      escalateTo: docs-lead
    
    - id: ux-review
      role: ux-designer
      canReject: true
      description: "Review UI/UX design"
      when: "tags.includes('ux') || tags.includes('frontend')"
      timeout: 2h
      escalateTo: design-lead
    
    - id: perf-test
      role: sre
      canReject: true
      description: "Load testing and performance validation"
      when: "tags.includes('performance') || tags.includes('scale')"
      timeout: 3h
      escalateTo: sre-lead
    
    - id: deploy-prep
      role: sre
      description: "Verify migrations and rollback plans"
      timeout: 1h
      escalateTo: ops-lead
    
    - id: po-approval
      role: po
      requireHuman: true
      description: "Product Owner final acceptance"
      timeout: 4h
      escalateTo: director
  
  outcomes:
    complete: advance
    needs_review: reject
    blocked: hold
```

### Task Example

```yaml
---
id: AOF-auth-001
title: "Implement OAuth2 authentication"
status: in_progress
routing:
  workflow: swe-sdlc
  role: backend
gate:
  current: implement
  entered: 2026-02-16T10:00:00Z
tags: [auth, security, api]          # Triggers security-review and docs-update
---

# Task Description
Implement OAuth2 authentication with JWT tokens.

## Acceptance Criteria
- [ ] OAuth2 flow implemented
- [ ] JWT validation middleware
- [ ] Refresh token support
- [ ] Tests cover all flows
```

### Gate Flow

With tags `[auth, security, api]`, this task will flow through:

1. **implement** (backend) — Build the feature
2. **code-review** (architect) — Review code quality
3. **qa-test** (qa) — Test functionality
4. **security-review** (security) — ✅ Activated by `auth` tag
5. **docs-update** (tech-writer) — ✅ Activated by `api` tag
6. **ux-review** — ❌ Skipped (no `ux` or `frontend` tag)
7. **perf-test** — ❌ Skipped (no `performance` tag)
8. **deploy-prep** (sre) — Deployment readiness
9. **po-approval** (po, human-only) — Final sign-off

---

## Best Practices

### Start Simple

Begin with a minimal 2-gate workflow (implement → review) and add gates as your process matures.

### Self-Documenting Configuration

Use rich inline comments in your workflow YAML. A new team member should understand the workflow by reading the file alone.

### Tag Consistently

Establish a consistent tagging vocabulary across your team:

- `skip-qa` — Bypass QA for trivial changes
- `security` — Trigger security review
- `api` — Trigger documentation updates
- `performance` — Trigger load testing

### Set Realistic Timeouts

Base timeout values on historical data, not aspirations. Start conservative and tighten as you measure actual cycle times.

### Monitor Gate Metrics

Track key metrics:

- **Gate duration**: How long tasks spend in each gate
- **Rejection rate**: Which gates reject most often
- **Timeout rate**: Which gates timeout most often
- **Skip rate**: Which conditional gates are skipped most

### Use Role-Based Assignment

Never hardcode agent IDs in workflows. Use roles for flexibility and maintainability.

### Test Conditional Logic

Validate that your `when` expressions work as expected:

```bash
aof test workflow --workflow swe-sdlc --task task.yaml --dry-run
```

### Document Escalation Paths

Ensure escalation roles have capacity to unblock. Document escalation procedures in your team handbook.

---

## Troubleshooting

### Task Stuck in Gate

**Symptom**: Task hasn't progressed in hours  
**Diagnosis**: Check timeout configuration and agent availability  
**Fix**: Adjust timeout or ensure agents with the role are active

```bash
aof task status AOF-abc --verbose
aof agents list --role reviewer --active
```

### Gate Keeps Rejecting

**Symptom**: Task loops between implement and review  
**Diagnosis**: Review feedback in `reviewContext`  
**Fix**: Address blockers before resubmitting

```bash
aof task history AOF-abc --gate-history
```

### Conditional Gate Not Activating

**Symptom**: Expected gate is skipped  
**Diagnosis**: Check `when` expression and task tags  
**Fix**: Verify task metadata matches condition

```bash
aof task inspect AOF-abc --fields tags,metadata
aof workflow test --gate security-review --task AOF-abc
```

### Role Not Found

**Symptom**: "Role not found in org chart" error  
**Diagnosis**: Role referenced in workflow doesn't exist in org.yaml  
**Fix**: Add role definition to org chart

```bash
aof validate workflow --workflow swe-sdlc --org org.yaml
```

---

## Examples

See the `examples/` directory for complete workflow samples:

- **[simple-review.yaml](examples/simple-review.yaml)** — Minimal 2-gate workflow for small teams
- **[swe-sdlc.yaml](examples/swe-sdlc.yaml)** — Full 9-gate SWE workflow with conditionals
- **[sales-pipeline.yaml](examples/sales-pipeline.yaml)** — Non-SWE example demonstrating domain neutrality

---

## Further Reading

- **[Design Document](design/WORKFLOW-GATES-DESIGN.md)** — Complete technical design and architecture
- **[API Reference](API.md)** — Programmatic workflow API
- **[Beads Integration](BEADS-INTEGRATION.md)** — Task management integration

---

## Changelog

### 1.0 (2026-02-16)
- Initial release
- Basic gate progression
- Conditional gates
- Timeout and escalation
- Human-only gates
- Role-based assignment
