# Agentic SDLC Design — Reference Workflow for AOF

**Version:** 1.0  
**Author:** Software Architect  
**Date:** 2026-02-16  
**Status:** DESIGN — For PO/PM Review

---

## Executive Summary

This document defines the **reference Software Development Lifecycle (SDLC)** for autonomous agent teams using AOF's Workflow Gates primitive. It blends Extreme Programming (especially TDD), Continuous Delivery, and Accelerate principles into a workflow optimized for stateless agents with variable capability.

**Key Innovation:** This SDLC treats **rejection as a first-class learning signal**, not failure. Fast feedback loops, immediate metrics, and automated escalation ensure no task stalls while quality remains uncompromised.

**Target Audience:** This workflow is designed for fully autonomous agent teams with human oversight via metrics/dashboards, not ceremony participation.

---

## Table of Contents

1. [Philosophy: Agentic vs Human SDLC](#philosophy)
2. [Complete Gate Pipeline](#gate-pipeline)
3. [AOF Workflow Configuration](#aof-config)
4. [Gate Descriptions](#gate-descriptions)
5. [Anti-Stall Mechanisms](#anti-stall)
6. [Metrics & Learning Loops](#metrics)
7. [Task Structure & Frontmatter Schema](#task-structure)
8. [Conditional Paths by Task Type](#conditional-paths)
9. [WIP Limits & Flow Management](#wip-limits)
10. [Example Walkthrough](#example-walkthrough)

---

## 1. Philosophy: What Makes Agentic SDLC Different? {#philosophy}

### Core Constraints

| Human SDLC | Agentic SDLC |
|------------|--------------|
| Developers retain context across days/weeks | **Agents are stateless** — all context must travel with task |
| Uniform capability (senior devs all roughly equivalent) | **Wildly variable capability** (GPT-5 vs Qwen3-30B) |
| Pair programming for real-time collaboration | **Async review only** — pairing too expensive |
| Meetings/ceremonies for alignment | **No ceremonies** — alignment via task metadata and rejection feedback |
| Manual escalation when blocked | **Automatic escalation** — timeouts + PM monitoring |
| Code review as quality gate | **Multi-layer validation** — code review + QA + security + PO |

### Design Principles

#### 1. Context-Complete Tasks
Every task must be **executable in a single agent session** with zero external context lookups. Task frontmatter includes:
- Full acceptance criteria (testable conditions)
- Links to relevant code/docs
- Prior rejection feedback (if looping back)
- Architectural constraints
- Test count expectations

**Why:** Agents have no session memory. Looking up "what did the PO want?" mid-task wastes tokens and introduces errors.

#### 2. TDD as Non-Negotiable Quality Gate
Tests are written BEFORE implementation, not after. This is enforced at code review:
- Architect rejects any PR where tests were added post-implementation
- Test commits must have earlier timestamps than implementation commits
- Test-to-code ratio monitored per agent

**Why:** TDD forces clarity of interface and reduces rework. For agents (which can't "think through" a design interactively), tests ARE the specification.

#### 3. Rejection is Signal, Not Failure
Rejection rate is a **lagging indicator of task quality**, not agent performance. We optimize for:
- Fast rejection (< 30 min review SLA)
- Specific feedback (actionable, not vague)
- Learning accumulation (patterns fed into retros)

**Why:** Agents can't learn from vague feedback ("this isn't good enough"). Specific rejections ("test coverage 67%, needs 80%") are immediately actionable.

#### 4. Small Batches, Trunk-Based Development
- Work items scoped to < 4 hours per gate (target: 2 hours)
- No long-lived branches — every task merges to trunk
- Feature flags for incomplete features (deploy dark, light up when ready)

**Why:** Large batches = long feedback cycles = more rework. Agents optimize on immediate feedback.

#### 5. Automated Governance, Zero Ceremony
No standups, retros, or planning meetings with agents. Instead:
- PM analyzes throughput/velocity metrics → adjusts backlog priority
- PO reviews completed work → accepts or rejects with criteria
- Architect reviews code → approves or rejects with technical feedback
- Retrospectives are **automated** — analyze rejection patterns, bottleneck gates, agent-specific rework rates

**Why:** Agents don't benefit from synchronous meetings. Metrics + async feedback loops are more efficient.

#### 6. Anti-Stall as a System Property
The pipeline CANNOT stall. If any gate exceeds timeout:
1. Escalate to PM (rebalance workload)
2. Escalate to Architect (technical blocker)
3. Escalate to PO (requirements clarification)
4. Dead-letter queue (permanently stuck → manual intervention)

**Why:** Agents can't proactively escalate ("hey, I'm stuck"). System must detect and route automatically.

---

## 2. Complete Gate Pipeline {#gate-pipeline}

### Gate Sequence Overview

```
┌─────────────┐
│   BACKLOG   │ (PO/PM manage)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  READY-CHK  │ (PM validates task is actionable)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ IMPLEMENT   │ (Backend/Frontend/etc - TDD mandatory)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ CODE-REVIEW │ (Architect - technical quality gate)
└──────┬──────┘
       │ reject ─────┐
       │             │
       ▼             │
┌─────────────┐      │
│     QA      │      │
└──────┬──────┘      │
       │ reject ─────┤
       │             │
       ▼             │
┌─────────────┐      │
│  SECURITY   │ (conditional: security-tagged tasks only)
└──────┬──────┘      │
       │ reject ─────┤
       │             │
       ▼             │
┌─────────────┐      │
│    DOCS     │ (conditional: docs-tagged or API changes)
└──────┬──────┘      │
       │ reject ─────┤
       │             │
       ▼             │
┌─────────────┐      │
│  PO-ACCEPT  │      │
└──────┬──────┘      │
       │ reject ─────┘ (all rejections loop to IMPLEMENT with feedback)
       │
       ▼
┌─────────────┐
│   DEPLOY    │ (conditional: deployable projects only; owned by SRE)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│    DONE     │
└─────────────┘
```

### Rejection Loop Behavior

When any gate rejects:
- Task moves back to **IMPLEMENT** gate (not previous gate)
- **Rejection context** appended to task frontmatter:
  - Which gate rejected
  - Timestamp
  - Specific blockers (actionable list)
  - Links to failed checks (test output, coverage reports, etc.)
- Task reassigned to **same role** (backend/frontend/etc) — may be different agent instance
- Cycle count incremented (for metrics)

**Why loop to IMPLEMENT, not previous gate?**
- Most rejections require code changes, which means re-implementation
- Looping through code-review → QA → security again for small fixes wastes cycles
- Exception: If rejection is "tests are wrong" (not implementation), architect can reject to IMPLEMENT with "fix tests only" instruction

---

## 3. AOF Workflow Configuration {#aof-config}

### Complete Workflow YAML

```yaml
# ~/Projects/<project>/project.yaml
workflow:
  name: "Agentic SDLC - Full Pipeline"
  version: "1.0"
  
  # WIP limits (per gate, per role)
  limits:
    global: 20              # Total active tasks across all gates
    per_gate:
      implement: 5          # Max 5 tasks in implementation simultaneously
      code-review: 3
      qa: 3
      security: 2
      docs: 2
      po-accept: 3
      deploy: 1             # Serial deploys only
  
  # SLA timeouts (minutes) - after this, escalate
  timeouts:
    ready-check: 30
    implement: 240          # 4 hours (should be <2 for most tasks)
    code-review: 60
    qa: 120
    security: 180
    docs: 90
    po-accept: 60
    deploy: 45
  
  # Escalation chain (per gate)
  escalation:
    default: ["pm", "architect", "po"]  # PM first, then architect, then PO
    deploy: ["sre", "architect", "po"]  # SRE-specific escalation
  
  # Gate definitions
  gates:
    # --- BACKLOG MANAGEMENT ---
    - id: backlog
      role: pm
      description: "Task is in backlog, not yet ready for work"
      auto_advance: false   # PM manually promotes to ready-check
      
    - id: ready-check
      role: pm
      description: "PM validates task has clear AC, dependencies resolved, appropriate scope"
      can_reject: true
      reject_to: backlog
      acceptance_criteria:
        - "Acceptance criteria are testable (not vague)"
        - "Dependencies marked complete or blocked reason documented"
        - "Task scoped to <4 hours estimated effort"
        - "Task type tagged (feature/bug/docs/security)"
      timeout_min: 30
      
    # --- IMPLEMENTATION ---
    - id: implement
      role: "{{ task.role }}"  # Dynamic: backend, frontend, data-eng, etc.
      description: "Agent implements solution following TDD - tests first, then code"
      can_reject: false        # Implementation gate doesn't reject (it's the starting point for work)
      acceptance_criteria:
        - "Tests written BEFORE implementation (verified via git timestamps)"
        - "All tests passing locally"
        - "Code follows project style guide"
        - "No commented-out code or debug prints"
        - "Commit messages follow conventional commits format"
      timeout_min: 240
      
    # --- CODE REVIEW ---
    - id: code-review
      role: architect
      description: "Architect reviews technical quality, architecture compliance, test quality"
      can_reject: true
      reject_to: implement
      acceptance_criteria:
        - "Tests were written first (TDD verified)"
        - "Test coverage >= 80% for new code"
        - "Tests cover edge cases, not just happy path"
        - "Code follows architectural patterns (no god files, localized logic)"
        - "No duplicate logic (DRY violations)"
        - "Functions <120 LOC, files <500 LOC (hard limits)"
        - "Error handling present and correct"
        - "No security anti-patterns (SQL injection, XSS, etc.)"
      rejection_criteria:
        - "TDD not followed (implementation committed before tests)"
        - "Coverage below 80%"
        - "Architectural violations (coupled modules, god files)"
        - "Missing error handling"
        - "Code style violations"
      timeout_min: 60
      
    # --- QA VALIDATION ---
    - id: qa
      role: qa
      description: "QA validates tests are correct, meaningful, and implementation meets AC"
      can_reject: true
      reject_to: implement
      acceptance_criteria:
        - "All acceptance criteria from task met"
        - "Tests validate actual requirements (not just code coverage)"
        - "Edge cases handled correctly"
        - "No regression in existing functionality"
        - "Integration tests added for cross-module changes"
        - "Manual QA checklist completed (if applicable)"
      rejection_criteria:
        - "AC not met"
        - "Tests are trivial/meaningless"
        - "Edge cases not covered"
        - "Regression detected"
      timeout_min: 120
      
    # --- SECURITY REVIEW (conditional) ---
    - id: security
      role: security
      description: "Security review for security-tagged work or authentication/authorization changes"
      when: "task.tags.includes('security') || task.changes.some(f => f.includes('auth'))"
      can_reject: true
      reject_to: implement
      acceptance_criteria:
        - "No secrets in code or config (use env vars / secret manager)"
        - "Input validation on all user-supplied data"
        - "Authentication/authorization logic correct"
        - "SQL injection / XSS / CSRF protections in place"
        - "Dependencies have no known CVEs (npm audit / Snyk clean)"
        - "Sensitive data encrypted at rest and in transit"
      rejection_criteria:
        - "Secrets in code"
        - "Missing input validation"
        - "Auth/authz vulnerabilities"
        - "Dependency CVEs"
      timeout_min: 180
      
    # --- DOCUMENTATION (conditional) ---
    - id: docs
      role: tech-writer
      description: "Tech writer validates documentation quality for docs-tagged tasks or API changes"
      when: "task.tags.includes('docs') || task.changes.some(f => f.includes('API') || f.endsWith('.md'))"
      can_reject: true
      reject_to: implement
      acceptance_criteria:
        - "API docs updated (if API changed)"
        - "Architecture docs updated (if structure changed)"
        - "User-facing docs written in clear, professional language"
        - "Code examples work and are tested"
        - "Markdown formatting correct"
        - "Links are valid (no 404s)"
      rejection_criteria:
        - "Docs missing or incomplete"
        - "Poor writing quality (unclear, unprofessional)"
        - "Broken links or examples"
      timeout_min: 90
      
    # --- PO ACCEPTANCE ---
    - id: po-accept
      role: po
      description: "Product Owner validates work meets business requirements and is shippable"
      can_reject: true
      reject_to: implement
      acceptance_criteria:
        - "All original acceptance criteria met"
        - "Behavior matches PO's intent (not just letter of AC)"
        - "UX is acceptable (if user-facing)"
        - "No scope creep or unrelated changes"
      rejection_criteria:
        - "Doesn't meet AC"
        - "Wrong interpretation of requirements"
        - "UX issues"
        - "Scope creep"
      timeout_min: 60
      
    # --- DEPLOYMENT (conditional) ---
    - id: deploy
      role: sre
      description: "SRE deploys to production and validates health"
      when: "project.deployable == true"
      can_reject: true
      reject_to: implement   # Deploy failures loop back to implementation for fixes
      acceptance_criteria:
        - "Deployment succeeds (no errors)"
        - "Health checks pass post-deploy"
        - "Monitoring/alerting configured"
        - "Rollback plan documented"
        - "Zero downtime (blue-green or canary)"
        - "Performance metrics within acceptable range"
      rejection_criteria:
        - "Deployment fails"
        - "Health checks fail"
        - "Performance degradation detected"
      timeout_min: 45
      escalation: ["sre", "architect", "po"]  # SRE-specific escalation
      
    # --- DONE ---
    - id: done
      role: null
      description: "Task complete, all gates passed"
      terminal: true
```

---

## 4. Gate Descriptions {#gate-descriptions}

### Gate: BACKLOG
- **Owner:** PM
- **Purpose:** Task repository, not yet ready for work
- **Entry:** PO creates task from user story or tech debt
- **Exit:** PM promotes to `ready-check` when dependencies resolved
- **Rejection:** N/A (backlog doesn't reject)
- **Metrics:**
  - Backlog size (count)
  - Age of oldest task (staleness)
  - Backlog growth rate (inflow vs outflow)

---

### Gate: READY-CHECK
- **Owner:** PM
- **Purpose:** Validate task is actionable before assigning to engineer
- **Acceptance Criteria:**
  1. **Testable AC:** Acceptance criteria are specific, measurable, testable (not "improve performance" but "reduce API latency to <200ms p95")
  2. **Dependencies clear:** All blocking tasks marked complete, or blocking reason documented
  3. **Scoped correctly:** Estimated <4 hours total effort across all gates (target: 2 hours)
  4. **Tagged appropriately:** Task type clear (feature/bug/docs/security) for conditional gate routing
  5. **Context complete:** Links to relevant code, docs, prior discussions included
- **Rejection Criteria:**
  - AC too vague ("make it better")
  - Unresolved blockers
  - Task too large (>4 hour estimate)
  - Missing context
- **Rejection Target:** `backlog` (with feedback for PO/PM to refine)
- **Timeout:** 30 min → escalate to Architect (was PM underspecified?)
- **Metrics:**
  - Ready-check rejection rate (indicates poor task grooming)
  - Time in ready-check (should be <30 min)

---

### Gate: IMPLEMENT
- **Owner:** Dynamic (`task.role` — backend, frontend, data-eng, etc.)
- **Purpose:** Agent writes tests first, then implements solution
- **TDD Workflow:**
  1. Read task AC carefully
  2. Write failing tests that validate each AC
  3. Commit tests (separate commit, timestamp recorded)
  4. Implement code to make tests pass
  5. Commit implementation (timestamp recorded)
  6. Run full test suite locally
  7. Signal completion with `aof_task_complete(outcome: "complete")`
- **Acceptance Criteria:**
  1. **TDD followed:** Test commits have earlier timestamps than implementation commits (verified via git log)
  2. **Tests passing:** All tests green locally
  3. **Style compliance:** Code follows project linter/formatter rules
  4. **Clean commits:** Conventional commit messages, no debug code left in
- **Output Artifacts:**
  - Code changes (PR/patch)
  - Test changes (must be FIRST in commit history)
  - Local test run output (passed)
- **Timeout:** 240 min (4 hours) → escalate to PM (task too complex? needs decomposition?)
- **Rejection:** N/A (this is the entry point for work; rejections come back HERE)
- **Metrics:**
  - Implementation time per task (by agent, by task type)
  - Test-first compliance rate (% tasks where tests committed before code)
  - Rework cycles (how many times task looped back here)

---

### Gate: CODE-REVIEW
- **Owner:** Architect
- **Purpose:** Technical quality gate — validate correctness, architecture compliance, test quality
- **Review Checklist:**
  1. **TDD Verification:** Check git log — were tests committed before implementation?
     - If NO → auto-reject with "TDD not followed"
  2. **Test Coverage:** Run coverage report — is new code >= 80% covered?
     - If NO → reject with coverage gap details
  3. **Test Quality:** Are tests meaningful?
     - Do they validate AC, not just code?
     - Do they cover edge cases (null inputs, boundaries, error paths)?
     - Are they readable and maintainable?
  4. **Architecture Compliance:**
     - No god files (>500 LOC)
     - No god functions (>120 LOC)
     - Logic localized (related behavior grouped, not scattered)
     - Table-driven design for repetitive branching
  5. **Code Quality:**
     - No DRY violations (duplicate logic)
     - Error handling present and correct
     - No security anti-patterns (hardcoded secrets, SQL injection vectors, etc.)
     - No commented-out code or debug artifacts
- **Acceptance Criteria:**
  - All checklist items pass
  - Code is architecturally sound and maintainable
- **Rejection Criteria:**
  - TDD not followed (most common rejection)
  - Coverage < 80%
  - Architectural violations (god files, coupling, scattered logic)
  - Missing error handling
  - Code style issues (linter failures)
  - Security concerns (escalate to Security if severe)
- **Rejection Payload:**
  - Specific line numbers / file references
  - Coverage gap report (which lines uncovered)
  - Concrete fix instructions ("Add tests for error path in `handleRequest:45`")
- **Rejection Target:** `implement`
- **Timeout:** 60 min → escalate to PM (architect overloaded? need more reviewers?)
- **Metrics:**
  - Code review rejection rate (by agent, by rejection reason)
  - Time in code review (target: <30 min per task)
  - Rejection reason distribution (TDD violations, coverage, style, architecture)

---

### Gate: QA
- **Owner:** QA Engineer Agent
- **Purpose:** Validate tests are correct and implementation meets acceptance criteria
- **Review Focus:**
  1. **AC Validation:** Does the implementation actually meet every acceptance criterion?
     - Not "does code run" but "does behavior match requirements"
  2. **Test Correctness:** Are tests validating the RIGHT things?
     - Common failure: tests check implementation details, not behavior
     - Example bad test: "function returns 3 items" when AC says "show active users only"
  3. **Edge Cases:** Are boundary conditions handled?
     - Empty inputs, null values, max/min boundaries
     - Concurrent access (if relevant)
     - Error conditions (network failures, timeouts, etc.)
  4. **Regression:** Does this change break existing functionality?
     - Run full test suite, not just new tests
     - Check related modules (integration risk)
  5. **Manual Verification (if applicable):**
     - For UI changes: screenshot/screen recording review
     - For API changes: Postman/curl validation
     - For data changes: query result validation
- **Acceptance Criteria:**
  - All AC met with evidence (test output, screenshots, logs)
  - Tests validate behavior, not implementation
  - Edge cases covered
  - No regressions
- **Rejection Criteria:**
  - AC not met
  - Tests are trivial/meaningless ("test that function exists")
  - Edge cases not covered
  - Regression detected
  - Tests check wrong thing (implementation detail vs behavior)
- **Rejection Payload:**
  - Which AC failed
  - Test output showing failure
  - Specific gaps ("missing error handling test for network timeout")
- **Rejection Target:** `implement`
- **Timeout:** 120 min → escalate to PM (QA overloaded? flaky tests?)
- **Metrics:**
  - QA rejection rate (indicates test quality issues)
  - Time in QA
  - Rejection reason (AC not met, edge cases, regression, test correctness)
  - Escape rate (bugs found in later gates or production → QA process gap)

---

### Gate: SECURITY (Conditional)
- **Owner:** Security Engineer Agent
- **Trigger:** Task tagged `security` OR changes include auth/authz code
- **Purpose:** Prevent security vulnerabilities from shipping
- **Review Checklist:**
  1. **Secrets Management:**
     - No hardcoded secrets (API keys, passwords, tokens)
     - Environment variables or secret manager used correctly
     - No secrets in logs or error messages
  2. **Input Validation:**
     - All user-supplied data validated (type, length, format, range)
     - SQL injection protection (parameterized queries, not string concatenation)
     - XSS protection (output escaping, CSP headers)
     - Path traversal protection (no raw file paths from user input)
  3. **Authentication/Authorization:**
     - Auth checks present and correct
     - No privilege escalation vectors
     - Session management secure (httpOnly, secure flags)
     - Token expiration enforced
  4. **Dependencies:**
     - Run `npm audit` / `Snyk` / `OWASP Dependency-Check`
     - No HIGH or CRITICAL CVEs
     - Acceptable CVEs documented with mitigation plan
  5. **Cryptography:**
     - Use standard libraries (no homebrew crypto)
     - Sensitive data encrypted at rest (if applicable)
     - TLS enforced for data in transit
  6. **Error Handling:**
     - No sensitive info in error messages (stack traces, DB schema, internal paths)
     - Generic errors to users, detailed logs server-side
- **Acceptance Criteria:**
  - All checklist items pass
  - No HIGH/CRITICAL CVEs
  - Security best practices followed
- **Rejection Criteria:**
  - Secrets in code
  - Missing input validation
  - Auth/authz vulnerabilities
  - HIGH/CRITICAL CVEs
  - Crypto misuse
- **Rejection Payload:**
  - CVE list (if dependency issue)
  - Specific vulnerability location (file, line, type)
  - Remediation guidance (link to OWASP, CWE, etc.)
- **Rejection Target:** `implement`
- **Timeout:** 180 min (3 hours) → escalate to Architect (complex security analysis)
- **Metrics:**
  - Security rejection rate
  - Rejection reason (secrets, validation, auth, CVEs)
  - Time to remediate security issues (cycle time from rejection to re-review)
  - CVE count per task

---

### Gate: DOCS (Conditional)
- **Owner:** Tech Writer Agent
- **Trigger:** Task tagged `docs` OR changes include API modifications OR markdown files changed
- **Purpose:** Ensure documentation is clear, professional, and up-to-date
- **Review Checklist:**
  1. **API Documentation (if API changed):**
     - Endpoints documented (method, path, params, response)
     - Request/response examples provided
     - Error codes documented
     - Authentication requirements clear
  2. **Architecture Documentation (if structure changed):**
     - Diagrams updated (if applicable)
     - Module relationships documented
     - Design decisions recorded (ADRs)
  3. **User-Facing Documentation:**
     - Clear, professional language (not developer jargon unless dev-audience)
     - Step-by-step instructions where appropriate
     - Screenshots/examples for UI changes
  4. **Code Examples:**
     - Examples are tested and work
     - Examples are complete (not pseudocode unless explicitly stated)
     - Examples follow best practices
  5. **Formatting & Links:**
     - Markdown formatting correct (headers, lists, code blocks)
     - Links are valid (no 404s)
     - Spelling/grammar correct
- **Acceptance Criteria:**
  - All relevant docs updated
  - Writing quality is high (clear, professional)
  - Examples work
  - Links valid
- **Rejection Criteria:**
  - Docs missing or incomplete
  - Poor writing quality (unclear, unprofessional, jargon-heavy)
  - Broken links or non-working examples
  - Formatting issues (broken markdown, inconsistent style)
- **Rejection Payload:**
  - Specific docs gaps ("API endpoint POST /users missing")
  - Writing feedback ("Step 3 unclear — what does 'configure it' mean?")
  - Broken links list
- **Rejection Target:** `implement`
- **Timeout:** 90 min → escalate to PM
- **Metrics:**
  - Docs rejection rate
  - Time in docs review
  - Docs quality score (survey from users? or automated readability metrics)

---

### Gate: PO-ACCEPT
- **Owner:** Product Owner
- **Purpose:** Business validation — does this meet the actual need?
- **Review Focus:**
  1. **AC Compliance:** All original acceptance criteria met?
  2. **Intent Match:** Does behavior match PO's intent, not just letter of AC?
     - Common failure: technically meets AC but wrong user experience
  3. **UX Quality (if user-facing):**
     - Is it usable?
     - Does it match product vision?
     - Are there confusing/frustrating aspects?
  4. **Scope Discipline:**
     - No scope creep (unrelated changes)
     - No gold-plating (unnecessary features)
  5. **Shippability:**
     - Is this ready for users?
     - Are there incomplete pieces that should be feature-flagged?
- **Acceptance Criteria:**
  - All AC met (verified by PO)
  - Behavior matches intent
  - UX acceptable (if applicable)
  - No scope creep
  - Ready to ship
- **Rejection Criteria:**
  - AC not met
  - Wrong interpretation of requirements
  - UX issues (confusing, broken, ugly)
  - Scope creep
  - Not shippable as-is
- **Rejection Payload:**
  - Which AC failed (if any)
  - Intent mismatch explanation ("This implements a queue, but users need priority sorting")
  - UX feedback ("Button placement confusing — users won't find it")
- **Rejection Target:** `implement` (rarely `backlog` if requirements were fundamentally wrong)
- **Timeout:** 60 min → escalate to PM (PO unavailable? delegate to PM with approval guidelines?)
- **Metrics:**
  - PO rejection rate (indicates poor requirement clarity)
  - Rejection reason (AC, intent, UX, scope)
  - Time in PO review

---

### Gate: DEPLOY (Conditional)
- **Owner:** SRE Agent
- **Trigger:** Project is deployable (`project.deployable == true`)
- **Purpose:** Deploy to production and validate health
- **Deployment Workflow:**
  1. **Pre-Deploy Validation:**
     - All tests passing in CI
     - Deployment plan reviewed (blue-green, canary, rolling)
     - Rollback plan documented
  2. **Deploy:**
     - Execute deployment (via CI/CD pipeline, not manual)
     - Zero downtime required (use blue-green or canary strategy)
  3. **Post-Deploy Validation:**
     - Health checks pass (all instances healthy)
     - Smoke tests pass (critical user paths work)
     - Performance metrics within acceptable range (latency, error rate, throughput)
     - Monitoring/alerting active
  4. **Rollback (if needed):**
     - Automated rollback if health checks fail
     - Manual rollback if issues detected post-deploy
- **Acceptance Criteria:**
  - Deployment succeeds
  - Health checks pass
  - Smoke tests pass
  - Performance metrics acceptable
  - Monitoring active
- **Rejection Criteria:**
  - Deployment fails (infra issue, config error, etc.)
  - Health checks fail
  - Performance degradation detected (latency spike, error rate increase)
  - Monitoring not configured
- **Rejection Payload:**
  - Deployment logs (errors, failures)
  - Health check failures
  - Performance metrics comparison (before vs after)
  - Rollback instructions (if not auto-rolled back)
- **Rejection Target:** `implement` (fix code/config issue)
- **Timeout:** 45 min → escalate to Architect (deployment complexity issue?)
- **Escalation Path:** SRE → Architect → PO (different from default PM escalation)
- **Metrics:**
  - Deployment success rate (Accelerate: change failure rate)
  - Deployment duration
  - Rollback count
  - Mean time to recovery (MTTR)

---

### Gate: DONE
- **Owner:** N/A (terminal state)
- **Purpose:** Task complete, all gates passed
- **Entry:** Successful completion of all required gates
- **Metrics Emitted:**
  - Total cycle time (time from `ready-check` to `done`)
  - Gate breakdown (time spent in each gate)
  - Rejection count (how many loops)
  - Final outcome (success)

---

## 5. Anti-Stall Mechanisms {#anti-stall}

### Problem Statement
Agents cannot proactively escalate ("I'm stuck"). The system must **detect stalls automatically** and route to appropriate resolver.

### Stall Detection Strategies

#### 1. Timeout-Based Escalation
Every gate has a timeout (SLA). If task exceeds timeout:

```
Time Exceeded → Alert
  ↓
Check: Is assignee active? (Did agent claim the task?)
  ↓
NO → Reassign to another agent with same role
YES → Escalate to next level
```

**Escalation Chain (default):**
1. **PM** — Rebalance workload (too many tasks? reassign)
2. **Architect** — Technical blocker? (unclear requirements, missing dependency)
3. **PO** — Requirements issue? (AC unclear, scope wrong)
4. **Dead-Letter Queue** — Permanently stuck (manual intervention required)

**Escalation Chain (deploy-specific):**
1. **SRE** — Check deployment (infrastructure issue?)
2. **Architect** — Technical issue (code/config problem)
3. **PO** — Rollback decision (ship without this change?)

#### 2. PM Throughput Monitoring
PM agent runs periodic analysis (every 6 hours):

```typescript
// Pseudo-code for PM monitoring
async function detectStalls() {
  const metrics = await getMetrics();
  
  // Detect bottleneck gates
  if (metrics.gates.codeReview.avgTimeMinutes > 120) {
    alert("Code review bottleneck — architect overloaded");
    // Action: Reassign some reviews, or escalate to PO for approval to add reviewer capacity
  }
  
  // Detect individual stuck tasks
  const stuckTasks = metrics.tasks.filter(t => 
    t.timeInCurrentGate > gate.timeout * 1.5
  );
  for (const task of stuckTasks) {
    escalate(task, "timeout");
  }
  
  // Detect systemic issues
  if (metrics.rejectionRate.codeReview > 0.6) {
    alert("High code review rejection rate — TDD compliance issue");
    // Action: Analyze rejection reasons, update implementation agent prompts
  }
  
  // Detect velocity drop
  if (metrics.throughput.last24h < metrics.throughput.avg7day * 0.5) {
    alert("Throughput drop detected — investigate");
    // Action: Check agent health, task complexity, gate bottlenecks
  }
}
```

#### 3. Dead-Letter Queue
If task escalates through entire escalation chain and still blocked:

```
Task → Dead-Letter Queue
  ↓
Alert: Human intervention required
  ↓
PM investigates:
  - Is task fundamentally broken? (Cancel and create new task)
  - Is dependency external? (Park until dependency resolves)
  - Is requirements issue? (Send back to PO for re-scope)
```

Dead-letter tasks are **not forgotten** — PM reviews weekly, PO monthly.

#### 4. Automatic Reassignment
If agent claims task but doesn't complete within timeout:

```
Check agent health:
  - Is agent online?
  - Has agent processed other tasks recently?
  
IF agent healthy:
  → Escalate (task is complex, not agent failure)
  
IF agent unhealthy:
  → Reassign to different agent with same role
  → Log agent performance issue
```

### Metrics for Stall Detection

| Metric | Alert Threshold | Action |
|--------|----------------|--------|
| Time in gate > SLA * 1.5 | Any task | Escalate per escalation chain |
| Gate avg time > SLA * 2 | Sustained >2 hours | PM investigates bottleneck |
| Rejection rate > 60% | Any gate, sustained >12 hours | PM investigates systemic issue |
| Throughput < 50% of 7-day avg | Sustained >24 hours | PM escalates to PO (capacity issue?) |
| Dead-letter queue > 5 tasks | Any time | PM escalates to PO (process breakdown) |

---

## 6. Metrics & Learning Loops {#metrics}

### Accelerate Metrics (Primary)

#### 1. Lead Time for Changes
**Definition:** Time from commit to production deploy

**Target:** <1 day (agents should be much faster than humans)

**Measurement:**
```
Lead Time = timestamp(done) - timestamp(first_commit_in_implement)
```

**Tracked per:**
- Task
- Task type (feature, bug, docs, security)
- Agent (who implemented)

**Actionable Insights:**
- If lead time increasing → investigate bottleneck gates (code review, QA, PO accept)
- If lead time varies wildly by agent → training/prompt issue

#### 2. Deployment Frequency
**Definition:** How often we deploy to production

**Target:** Multiple deploys per day (for trunk-based development)

**Measurement:**
```
Deployment Frequency = count(deploy_success) / time_period
```

**Tracked per:**
- Project
- Time period (daily, weekly)

**Actionable Insights:**
- If frequency decreasing → WIP limit issue? Task size too large?
- If zero deploys for >24 hours → investigate pipeline health

#### 3. Change Failure Rate
**Definition:** % of deploys that fail or require rollback

**Target:** <15%

**Measurement:**
```
Change Failure Rate = count(deploy_rejected_or_rolled_back) / count(deploy_attempted)
```

**Tracked per:**
- Project
- Time period

**Actionable Insights:**
- If rate increasing → QA process gap? Test quality issue?
- If rate >30% → systemic problem, halt and investigate

#### 4. Mean Time to Recovery (MTTR)
**Definition:** Time from deploy failure to successful redeploy

**Target:** <1 hour

**Measurement:**
```
MTTR = timestamp(deploy_success_after_failure) - timestamp(deploy_failure)
```

**Tracked per:**
- Incident
- Project

**Actionable Insights:**
- If MTTR increasing → rollback process slow? Fix complexity increasing?
- If MTTR >4 hours → escalate to architect (architectural issue?)

### Gate-Specific Metrics

#### Per Gate:
- **Throughput:** Tasks completed per hour
- **Cycle Time:** Average time in gate
- **Rejection Rate:** % tasks rejected
- **Rejection Reason Distribution:** Which rejection criteria trigger most often

#### Per Agent:
- **Tasks Completed:** Count per time period
- **Rejection Rate:** % tasks rejected (by gate)
- **Rework Cycles:** Average loops back to implementation
- **Velocity:** Story points (or task count) completed per day

#### Per Task Type:
- **Lead Time:** By feature/bug/docs/security
- **Rejection Rate:** By type (security tasks rejected more often?)
- **Gate Coverage:** Which gates do different types pass through

### Learning Loops

#### 1. Automated Retrospectives (Weekly)
PM agent analyzes metrics and generates report:

```markdown
# Retrospective: Week of 2026-02-10

## Accelerate Metrics
- Lead Time: 6.2 hours (↓ from 8.1 hours last week) ✅
- Deployment Frequency: 18 deploys (↑ from 12) ✅
- Change Failure Rate: 22% (↑ from 11%) ⚠️
- MTTR: 45 min (→ unchanged) ✅

## Bottlenecks Detected
- **Code Review:** Avg 78 min (target: 60 min) — Architect overloaded
  - Action: Add second reviewer or increase timeout threshold
- **QA:** Rejection rate 31% (up from 18%) — Test quality declining
  - Action: Investigate test quality issues (see below)

## Top Rejection Reasons
1. Code Review — TDD not followed (18 tasks)
2. QA — AC not met (12 tasks)
3. Code Review — Coverage <80% (9 tasks)

## Agent Performance
- **Backend Agent A:** 24 tasks, 15% rejection rate ✅
- **Backend Agent B:** 18 tasks, 42% rejection rate ⚠️
  - Pattern: Consistently misses error handling
  - Action: Update agent prompt to emphasize error paths
- **QA Agent:** 31% rejection rate (issuing rejections) — Is QA too strict or implementation too loose?
  - Action: Review sample rejections for calibration

## Recommendations
1. Add code review capacity (bottleneck)
2. Investigate Agent B error handling pattern
3. Calibrate QA rejection criteria (sample review)
```

#### 2. Rejection Feedback Loop
Every rejection is analyzed for patterns:

```typescript
// Pseudo-code for rejection pattern analysis
async function analyzeRejections() {
  const rejections = await getRejections({ period: "7 days" });
  
  // Group by agent
  const byAgent = groupBy(rejections, r => r.task.assignee);
  for (const [agent, rejectionList] of byAgent) {
    if (rejectionList.length > 5) {
      const reasons = rejectionList.map(r => r.reason);
      const topReason = mode(reasons);  // Most common reason
      
      alert(`Agent ${agent} rejected ${rejectionList.length} times, mostly for: ${topReason}`);
      // Action: Update agent prompt or provide training examples
    }
  }
  
  // Group by gate
  const byGate = groupBy(rejections, r => r.gate);
  for (const [gate, rejectionList] of byGate) {
    const rate = rejectionList.length / totalTasksThroughGate(gate);
    if (rate > 0.4) {
      alert(`Gate ${gate} rejection rate: ${rate * 100}% (threshold: 40%)`);
      // Action: Investigate gate criteria (too strict?) or implementation quality (too loose?)
    }
  }
}
```

#### 3. Task Sizing Feedback
Track actual time vs estimated time:

```typescript
async function calibrateEstimates() {
  const tasks = await getCompletedTasks({ period: "30 days" });
  
  for (const task of tasks) {
    const estimate = task.estimatedHours;
    const actual = task.actualHours;
    
    if (actual > estimate * 2) {
      alert(`Task ${task.id} took ${actual}h, estimated ${estimate}h — underestimated`);
      // Action: Analyze why (missing dependencies? unclear AC? too complex?)
    }
  }
  
  // Learn: adjust estimation model
  const avgRatio = tasks.map(t => t.actualHours / t.estimatedHours).reduce((a, b) => a + b) / tasks.length;
  if (avgRatio > 1.5) {
    alert(`Systemic underestimation detected (avg actual/estimate: ${avgRatio})`);
    // Action: Adjust estimation multiplier for future tasks
  }
}
```

---

## 7. Task Structure & Frontmatter Schema {#task-structure}

### Task File Format

Every task is a markdown file with YAML frontmatter:

```markdown
---
# --- IDENTITY ---
id: AOF-abc123
title: "Add user authentication to API"
type: feature              # feature | bug | docs | security | chore
created: 2026-02-16T10:30:00Z
creator: po

# --- WORKFLOW STATE ---
currentGate: code-review
status: in-progress        # backlog | ready | in-progress | blocked | done
assignee: backend-agent-1
claimedAt: 2026-02-16T14:00:00Z

# --- WORKFLOW HISTORY ---
gateHistory:
  - gate: ready-check
    enteredAt: 2026-02-16T10:30:00Z
    exitedAt: 2026-02-16T10:45:00Z
    assignee: pm
    outcome: complete
    durationMin: 15
    
  - gate: implement
    enteredAt: 2026-02-16T10:45:00Z
    exitedAt: 2026-02-16T14:00:00Z
    assignee: backend-agent-1
    outcome: complete
    durationMin: 195
    commits:
      - sha: a1b2c3d
        timestamp: 2026-02-16T11:30:00Z
        message: "feat: add auth tests"
      - sha: e4f5g6h
        timestamp: 2026-02-16T13:45:00Z
        message: "feat: implement JWT auth"
        
  - gate: code-review
    enteredAt: 2026-02-16T14:00:00Z
    assignee: architect
    outcome: null            # Still in progress
    durationMin: null

# --- REJECTION HISTORY (if any) ---
rejections: []               # Populated on first rejection

# --- METADATA ---
tags:
  - auth
  - security               # Triggers security gate
  - backend
estimate: 3                # Hours
priority: high             # high | medium | low
sprint: "2026-W07"
dependencies:
  - AOF-xyz                # Blocking task IDs
blockedBy: []              # Currently unblocked

# --- METRICS ---
metrics:
  cycleCount: 0            # Number of rejection loops
  totalDuration: null      # Will be calculated when done
  testCount: 8
  testCoveragePercent: 85
---

# Add User Authentication to API

## Acceptance Criteria
1. **JWT Token Generation:** API endpoint `POST /auth/login` accepts username/password, returns JWT token
2. **Token Validation:** Middleware validates JWT on protected endpoints, rejects invalid tokens with 401
3. **Token Expiration:** Tokens expire after 24 hours, refresh endpoint available at `POST /auth/refresh`
4. **Test Coverage:** All auth logic covered with unit + integration tests (>80% coverage)
5. **Error Handling:** Clear error messages for invalid credentials, expired tokens, missing tokens
6. **Security:** Passwords never logged, tokens use HS256 signing, secret in env var not code

## Context
- **Related Code:** `src/api/auth.ts`, `src/middleware/authMiddleware.ts`
- **Related Docs:** `docs/api/authentication.md`
- **Dependencies:** AOF-xyz (user model schema) — COMPLETE

## Technical Constraints
- Use `jsonwebtoken` library (already in deps)
- Token secret via `process.env.JWT_SECRET`
- Passwords hashed with `bcrypt` (already in deps)
- Middleware should be reusable across all protected routes

## Test Expectations
- Unit tests for token generation, validation, expiration logic
- Integration tests for `/auth/login`, `/auth/refresh` endpoints
- Integration tests for middleware on protected endpoint
- Error path tests (invalid token, expired token, missing token, wrong password)
- Estimated: 8-10 tests

## Out of Scope
- User registration (separate task)
- OAuth/SSO integration (future)
- Password reset flow (separate task)

---

## Gate: CODE-REVIEW (Current)

**Assigned:** architect  
**Claimed:** Not yet  
**SLA:** 60 minutes (expires 2026-02-16T15:00:00Z)

**Review Checklist:**
- [ ] TDD followed (tests committed before implementation)
- [ ] Test coverage >= 80%
- [ ] Tests are meaningful (validate AC, not just code)
- [ ] No god files/functions (LOC limits respected)
- [ ] Error handling present
- [ ] No security anti-patterns
- [ ] Code style compliant

---

## Implementation Summary

Implemented JWT-based authentication with token generation, validation, and refresh endpoints. All AC met:
- ✅ POST /auth/login generates JWT
- ✅ Middleware validates token on protected routes
- ✅ Token expiration + refresh endpoint
- ✅ Test coverage 85% (8 tests)
- ✅ Error handling for all edge cases
- ✅ Security: passwords hashed, secret in env var

**Files Changed:**
- `src/api/auth.ts` (+120 LOC)
- `src/middleware/authMiddleware.ts` (+45 LOC)
- `tests/api/auth.test.ts` (+95 LOC)
- `tests/middleware/authMiddleware.test.ts` (+60 LOC)

**Test Results:**
```
✓ POST /auth/login with valid credentials returns token (18ms)
✓ POST /auth/login with invalid credentials returns 401 (12ms)
✓ POST /auth/refresh with valid token returns new token (15ms)
✓ POST /auth/refresh with expired token returns 401 (11ms)
✓ Middleware allows request with valid token (8ms)
✓ Middleware rejects request with invalid token (9ms)
✓ Middleware rejects request with missing token (7ms)
✓ Token expires after 24 hours (5ms)

Test Suites: 2 passed, 2 total
Tests:       8 passed, 8 total
Coverage:    85.3% statements, 82.1% branches
```
```

### Rejection Augmentation

When task is rejected, rejection context appended to frontmatter:

```yaml
rejections:
  - gate: code-review
    rejectedAt: 2026-02-16T14:30:00Z
    rejectedBy: architect
    reason: "TDD not followed"
    blockers:
      - "Implementation committed before tests (test commit at 11:30, implementation at 13:45 should be reversed)"
      - "Test coverage 85% but excludes error paths in authMiddleware.ts lines 34-42"
    actionRequired: "Re-order commits (tests first) and add error path tests"
    rejectionCycle: 1
```

Task returns to `implement` gate with this context. Next agent sees rejection history and knows exactly what to fix.

---

## 8. Conditional Paths by Task Type {#conditional-paths}

Different task types take different routes through the pipeline:

### Task Type: Feature (Standard Path)
```
ready-check → implement → code-review → qa → po-accept → [deploy] → done
                               ↓ reject
                          [security if tagged]
                          [docs if API change]
```

### Task Type: Bug (Security Skipped Unless Critical)
```
ready-check → implement → code-review → qa → po-accept → [deploy] → done
                               ↓ reject
                          [security if tags.critical]
```

### Task Type: Docs-Only (Implementation & QA Skipped)
```
ready-check → implement → docs → po-accept → done
              (minimal)      ↓ reject
```

**Rationale:** Docs-only tasks don't need code review or QA. Implementation gate still exists but is pass-through (agent just edits markdown).

### Task Type: Security (Extended Path)
```
ready-check → implement → code-review → qa → security → docs → po-accept → [deploy] → done
                               ↓ reject all gates
```

**Rationale:** Security-tagged tasks ALWAYS go through security review + docs (security changes must be documented).

### Task Type: Chore (Minimal Path)
```
ready-check → implement → code-review → done
                               ↓ reject
```

**Rationale:** Chores (refactoring, tech debt, tooling) don't need QA or PO approval — architect approval sufficient.

### Conditional Logic in YAML

```yaml
gates:
  - id: security
    role: security
    when: "task.tags.includes('security') || task.tags.includes('critical')"
    
  - id: docs
    role: tech-writer
    when: "task.tags.includes('docs') || task.type === 'security' || task.changes.some(f => f.includes('API'))"
    
  - id: qa
    role: qa
    when: "task.type !== 'chore' && task.type !== 'docs'"
    
  - id: deploy
    role: sre
    when: "project.deployable === true"
```

### Gate Skipping Logic

When scheduler evaluates next gate:

```typescript
function getNextGate(task: Task, currentGate: Gate): Gate | null {
  const workflow = getWorkflowForProject(task.projectId);
  const currentIndex = workflow.gates.findIndex(g => g.id === currentGate.id);
  
  // Find next gate that isn't skipped by conditional logic
  for (let i = currentIndex + 1; i < workflow.gates.length; i++) {
    const gate = workflow.gates[i];
    
    if (!gate.when || evaluateCondition(gate.when, task)) {
      return gate;  // This gate applies
    }
    // else: skip this gate, check next
  }
  
  return null;  // No more gates — task done
}
```

---

## 9. WIP Limits & Flow Management {#wip-limits}

### Why WIP Limits Matter for Agents

**Human teams:** WIP limits prevent context-switching overhead

**Agent teams:** WIP limits prevent:
1. **Token waste** — too many tasks in flight = context loaded but not actively worked
2. **Queue buildup** — bottleneck gates overwhelmed
3. **Priority inversion** — high-priority tasks stuck behind low-priority in queue

### WIP Limit Strategy

#### Global Limit
**Max 20 active tasks** across entire pipeline (all gates)

**Why 20?**
- Assumes 5 implementation agents, 1 architect, 1 QA, 1 PO
- Each agent can handle 2-3 tasks simultaneously (load balance)
- Prevents backlog explosion

#### Per-Gate Limits

| Gate | WIP Limit | Rationale |
|------|-----------|-----------|
| Backlog | ∞ | Unlimited (not "in flight") |
| Ready-Check | 10 | PM can validate quickly |
| Implement | 5 | Max 5 engineers working simultaneously |
| Code Review | 3 | Architect reviews serially, limit queue depth |
| QA | 3 | QA validates serially |
| Security | 2 | Security reviews are slow, limit queue |
| Docs | 2 | Tech writer bandwidth limited |
| PO Accept | 3 | PO validates serially |
| Deploy | 1 | Serial deploys only (no concurrent) |

#### Per-Role Limits
Each agent can claim max 2 tasks simultaneously

**Why?**
- Allows parallelization (start next task while waiting on external dependency for first)
- Prevents single agent from hoarding work
- Balances load across agents with same role

### Enforcement

```typescript
async function canClaimTask(task: Task, agent: Agent): Promise<boolean> {
  const workflow = getWorkflowForProject(task.projectId);
  const gate = workflow.gates.find(g => g.id === task.currentGate);
  
  // Check global WIP limit
  const globalWIP = await countTasksInProgress(task.projectId);
  if (globalWIP >= workflow.limits.global) {
    return false;  // Global limit exceeded
  }
  
  // Check per-gate WIP limit
  const gateWIP = await countTasksInGate(task.projectId, task.currentGate);
  if (gateWIP >= workflow.limits.per_gate[task.currentGate]) {
    return false;  // Gate limit exceeded
  }
  
  // Check per-agent limit
  const agentWIP = await countTasksClaimedByAgent(agent.id);
  if (agentWIP >= 2) {
    return false;  // Agent already has 2 tasks
  }
  
  return true;  // All limits OK, can claim
}
```

### Flow Optimization

**Cumulative Flow Diagram (CFD):**
PM monitors task distribution across gates:

```
Tasks
  │
30│     ╱╲    Backlog (growing — need to groom)
  │    ╱  ╲
20│   ╱    ╲  
  │  ╱      ╲╱ Ready (stable)
10│ ╱        ╲ Implement (stable)
  │╱__________╲Code Review (bottleneck — deep queue)
0 └────────────────────────────── Time
```

**Action on bottleneck detection:**
- Add capacity (second reviewer)
- Increase WIP limit temporarily (with caution)
- Escalate to PO (accept lower quality bar temporarily?)

**Ideal CFD:** Smooth, parallel bands (no bulges = no bottlenecks)

---

## 10. Example Walkthrough {#example-walkthrough}

### Scenario: Add User Profile Endpoint (Feature Task)

**Task ID:** AOF-xyz789  
**Type:** feature  
**Tags:** backend, API, docs  
**Estimate:** 3 hours  
**Dependencies:** None  

---

#### T+0: Task Created

**Actor:** PO

PO creates task in backlog:

```yaml
id: AOF-xyz789
title: "Add GET /users/:id endpoint"
type: feature
currentGate: backlog
status: backlog
tags: [backend, API, docs]
acceptanceCriteria:
  - "GET /users/:id returns user object (id, name, email)"
  - "Returns 404 if user not found"
  - "Returns 401 if not authenticated"
  - "Test coverage >80%"
```

---

#### T+10min: Ready Check

**Actor:** PM

PM reviews backlog, promotes task to `ready-check` gate:

```yaml
currentGate: ready-check
assignee: pm
```

PM validates:
- ✅ AC are testable
- ✅ Dependencies clear (none)
- ✅ Scoped appropriately (~2 hours)
- ✅ Context complete

**Outcome:** COMPLETE

```yaml
gateHistory:
  - gate: ready-check
    outcome: complete
    durationMin: 8
```

**Next Gate:** `implement`

---

#### T+20min: Implementation Starts

**Actor:** Backend Agent

Scheduler assigns task to backend agent (role match):

```yaml
currentGate: implement
assignee: backend-agent-1
claimedAt: 2026-02-16T10:20:00Z
```

Agent reads task, implements TDD:

1. **T+25min:** Write failing tests
   ```typescript
   // tests/api/users.test.ts
   test('GET /users/:id returns user', async () => {
     const res = await request(app).get('/users/123');
     expect(res.status).toBe(200);
     expect(res.body).toMatchObject({ id: 123, name: expect.any(String) });
   });
   
   test('GET /users/:id returns 404 for missing user', async () => {
     const res = await request(app).get('/users/999');
     expect(res.status).toBe(404);
   });
   ```
   
   Commit: `a1b2c3d` at T+30min

2. **T+50min:** Implement endpoint
   ```typescript
   // src/api/users.ts
   router.get('/users/:id', authMiddleware, async (req, res) => {
     const user = await db.users.findById(req.params.id);
     if (!user) return res.status(404).json({ error: 'User not found' });
     res.json(user);
   });
   ```
   
   Commit: `e4f5g6h` at T+60min

3. **T+65min:** Run tests locally
   ```
   ✓ All 3 tests pass
   ✓ Coverage: 87%
   ```

4. **T+70min:** Signal completion
   ```typescript
   await aof.taskComplete({
     outcome: "complete",
     summary: "Implemented GET /users/:id with tests",
     commits: ["a1b2c3d", "e4f5g6h"],
     testsPassed: true,
     coveragePercent: 87
   });
   ```

**Outcome:** COMPLETE

```yaml
gateHistory:
  - gate: implement
    outcome: complete
    durationMin: 50
    commits:
      - { sha: a1b2c3d, timestamp: T+30min, message: "test: add user endpoint tests" }
      - { sha: e4f5g6h, timestamp: T+60min, message: "feat: implement GET /users/:id" }
```

**Next Gate:** `code-review`

---

#### T+75min: Code Review (First Attempt — REJECTED)

**Actor:** Architect

Scheduler assigns to architect:

```yaml
currentGate: code-review
assignee: architect
claimedAt: 2026-02-16T11:15:00Z
```

Architect reviews:

1. **TDD Check:** ✅ Tests committed before implementation (a1b2c3d at T+30, e4f5g6h at T+60)
2. **Coverage Check:** ✅ 87% (exceeds 80%)
3. **Test Quality Check:** ✅ Tests validate AC (success case, 404 case, auth case)
4. **Architecture Check:** ✅ Endpoint is simple, no god files
5. **Code Quality Check:** ❌ **FAIL** — Missing error handling

**Issue Found:**
```typescript
// What if db.users.findById() throws an error?
const user = await db.users.findById(req.params.id);
// No try/catch — unhandled promise rejection!
```

**Outcome:** REJECTED

```typescript
await aof.taskComplete({
  outcome: "needs_review",
  blockers: [
    "Missing error handling in src/api/users.ts line 23",
    "If db.users.findById() throws (DB connection failure, etc.), API returns 500 with no error message",
    "Add try/catch block and return 500 with generic error message"
  ]
});
```

```yaml
gateHistory:
  - gate: code-review
    outcome: needs_review
    durationMin: 10
    rejectedBy: architect
    
rejections:
  - gate: code-review
    rejectedAt: T+85min
    rejectedBy: architect
    reason: "Missing error handling"
    blockers:
      - "Missing error handling in src/api/users.ts line 23"
      - "If db.users.findById() throws (DB connection failure, etc.), API returns 500 with no error message"
      - "Add try/catch block and return 500 with generic error message"
    actionRequired: "Add try/catch with 500 error response"
    rejectionCycle: 1

metrics:
  cycleCount: 1
```

**Next Gate:** `implement` (loop back with rejection feedback)

---

#### T+90min: Implementation (Second Attempt)

**Actor:** Backend Agent (possibly different instance, same role)

Scheduler reassigns to backend role:

```yaml
currentGate: implement
assignee: backend-agent-2
claimedAt: 2026-02-16T11:30:00Z
```

Agent reads task INCLUDING rejection context:

```yaml
rejections:
  - gate: code-review
    reason: "Missing error handling"
    blockers:
      - "Missing error handling in src/api/users.ts line 23..."
```

Agent implements fix:

1. **T+95min:** Add error handling
   ```typescript
   // src/api/users.ts
   router.get('/users/:id', authMiddleware, async (req, res) => {
     try {
       const user = await db.users.findById(req.params.id);
       if (!user) return res.status(404).json({ error: 'User not found' });
       res.json(user);
     } catch (err) {
       console.error('Database error:', err);
       return res.status(500).json({ error: 'Internal server error' });
     }
   });
   ```
   
   Commit: `i9j0k1l` at T+100min

2. **T+105min:** Add error handling test
   ```typescript
   test('GET /users/:id returns 500 on database error', async () => {
     jest.spyOn(db.users, 'findById').mockRejectedValue(new Error('DB down'));
     const res = await request(app).get('/users/123');
     expect(res.status).toBe(500);
     expect(res.body.error).toBe('Internal server error');
   });
   ```
   
   Commit: `m2n3o4p` at T+110min

3. **T+115min:** Run tests
   ```
   ✓ All 4 tests pass (including new error handling test)
   ✓ Coverage: 91%
   ```

4. **T+120min:** Signal completion
   ```typescript
   await aof.taskComplete({
     outcome: "complete",
     summary: "Added error handling per code review feedback",
     commits: ["i9j0k1l", "m2n3o4p"],
     testsPassed: true,
     coveragePercent: 91
   });
   ```

**Outcome:** COMPLETE

```yaml
gateHistory:
  - gate: implement
    enteredAt: T+90min
    exitedAt: T+120min
    outcome: complete
    durationMin: 30
    commits:
      - { sha: i9j0k1l, timestamp: T+100min, message: "fix: add error handling to GET /users/:id" }
      - { sha: m2n3o4p, timestamp: T+110min, message: "test: add error handling test" }
```

**Next Gate:** `code-review` (second attempt)

---

#### T+125min: Code Review (Second Attempt — PASSED)

**Actor:** Architect

Scheduler assigns to architect:

```yaml
currentGate: code-review
assignee: architect
claimedAt: 2026-02-16T12:05:00Z
```

Architect reviews:

1. **TDD Check:** ⚠️ Error handling test added AFTER implementation — but this is acceptable in rework cycle (fixing specific issue)
2. **Coverage Check:** ✅ 91% (exceeds 80%)
3. **Test Quality Check:** ✅ Tests validate AC + error path
4. **Architecture Check:** ✅ Clean, simple
5. **Code Quality Check:** ✅ Error handling present, logs error, returns 500

**Outcome:** COMPLETE

```yaml
gateHistory:
  - gate: code-review
    outcome: complete
    durationMin: 8
```

**Next Gate:** `qa`

---

#### T+135min: QA Validation

**Actor:** QA Agent

Scheduler assigns to QA:

```yaml
currentGate: qa
assignee: qa-agent
claimedAt: 2026-02-16T12:15:00Z
```

QA agent validates:

1. **AC Validation:**
   - ✅ GET /users/:id returns user object
   - ✅ Returns 404 if user not found
   - ✅ Returns 401 if not authenticated (authMiddleware)
   - ✅ Test coverage >80% (91%)
2. **Test Correctness:** ✅ Tests validate behavior, not implementation
3. **Edge Cases:** ✅ Error handling covered (DB failure case)
4. **Regression:** ✅ All existing tests still pass

**Outcome:** COMPLETE

```yaml
gateHistory:
  - gate: qa
    outcome: complete
    durationMin: 15
```

**Next Gate:** `docs` (task is tagged with "docs" and has API change)

---

#### T+150min: Docs Review

**Actor:** Tech Writer Agent

Scheduler assigns to tech writer (task tagged "API"):

```yaml
currentGate: docs
assignee: tech-writer
claimedAt: 2026-02-16T12:30:00Z
```

Tech writer reviews:

1. **API Docs:** ❌ **MISSING** — No documentation for GET /users/:id in `docs/api/users.md`

**Outcome:** REJECTED

```typescript
await aof.taskComplete({
  outcome: "needs_review",
  blockers: [
    "API endpoint GET /users/:id not documented in docs/api/users.md",
    "Add endpoint documentation with: method, path, auth requirements, response schema, error codes"
  ]
});
```

```yaml
gateHistory:
  - gate: docs
    outcome: needs_review
    durationMin: 10
    
rejections:
  - gate: docs
    rejectedAt: T+160min
    rejectedBy: tech-writer
    reason: "API docs missing"
    blockers:
      - "API endpoint GET /users/:id not documented..."
    rejectionCycle: 2

metrics:
  cycleCount: 2
```

**Next Gate:** `implement` (loop back)

---

#### T+165min: Implementation (Third Attempt — Docs)

**Actor:** Backend Agent

Agent reads rejection, adds documentation:

1. **T+170min:** Add API docs
   ```markdown
   # docs/api/users.md
   
   ## GET /users/:id
   
   Retrieve a user by ID.
   
   **Authentication:** Required (JWT token)
   
   **Request:**
   ```
   GET /users/123
   Authorization: Bearer <token>
   ```
   
   **Response (200 OK):**
   ```json
   {
     "id": 123,
     "name": "John Doe",
     "email": "john@example.com"
   }
   ```
   
   **Error Responses:**
   - `401 Unauthorized` — Missing or invalid token
   - `404 Not Found` — User does not exist
   - `500 Internal Server Error` — Database or server error
   ```
   
   Commit: `q5r6s7t` at T+175min

2. **T+180min:** Signal completion
   ```typescript
   await aof.taskComplete({
     outcome: "complete",
     summary: "Added API documentation for GET /users/:id",
     commits: ["q5r6s7t"]
   });
   ```

**Outcome:** COMPLETE

```yaml
gateHistory:
  - gate: implement
    outcome: complete
    durationMin: 15
    commits:
      - { sha: q5r6s7t, timestamp: T+175min, message: "docs: add GET /users/:id API documentation" }
```

**Next Gate:** `code-review`

---

#### T+185min: Code Review (Third Attempt — Docs Only)

**Actor:** Architect

Architect reviews docs change:

1. **Content Check:** ✅ Docs are clear, complete, professional
2. **Formatting:** ✅ Markdown formatting correct
3. **Accuracy:** ✅ Matches implementation

**Outcome:** COMPLETE (fast-tracked, docs-only change)

```yaml
gateHistory:
  - gate: code-review
    outcome: complete
    durationMin: 5
```

**Next Gate:** `qa`

---

#### T+190min: QA (Second Pass — Docs Only)

**Actor:** QA Agent

QA validates docs match implementation:

1. **Docs Accuracy:** ✅ API docs match actual endpoint behavior
2. **Examples Work:** ✅ Example requests/responses are correct

**Outcome:** COMPLETE (fast-tracked)

```yaml
gateHistory:
  - gate: qa
    outcome: complete
    durationMin: 5
```

**Next Gate:** `docs`

---

#### T+195min: Docs Review (Second Attempt — PASSED)

**Actor:** Tech Writer

Tech writer validates:

1. **API Docs:** ✅ Complete, clear, professional
2. **Formatting:** ✅ Markdown correct
3. **Links:** ✅ No broken links

**Outcome:** COMPLETE

```yaml
gateHistory:
  - gate: docs
    outcome: complete
    durationMin: 5
```

**Next Gate:** `po-accept`

---

#### T+200min: PO Acceptance

**Actor:** Product Owner

PO validates all AC met:

1. ✅ GET /users/:id returns user object
2. ✅ Returns 404 if user not found
3. ✅ Returns 401 if not authenticated
4. ✅ Test coverage >80% (91%)
5. ✅ Documented

**Outcome:** COMPLETE

```yaml
gateHistory:
  - gate: po-accept
    outcome: complete
    durationMin: 10
```

**Next Gate:** `deploy` (project is deployable)

---

#### T+210min: Deployment

**Actor:** SRE Agent

SRE deploys to production:

1. **Pre-Deploy:** ✅ All tests passing in CI
2. **Deploy:** Blue-green deployment initiated
3. **Health Check:** ✅ All instances healthy
4. **Smoke Test:** ✅ GET /users/123 returns 200
5. **Performance:** ✅ Latency within acceptable range (<200ms p95)

**Outcome:** COMPLETE

```yaml
gateHistory:
  - gate: deploy
    outcome: complete
    durationMin: 15
```

**Next Gate:** `done`

---

### Final Task State

```yaml
id: AOF-xyz789
status: done
currentGate: done
completedAt: 2026-02-16T13:30:00Z

metrics:
  cycleCount: 2              # Two rejection loops (code review, docs)
  totalDurationMin: 210      # 3.5 hours from ready-check to done
  leadTimeMin: 150           # 2.5 hours from first commit to deploy
  testCount: 4
  testCoveragePercent: 91
  
gateBreakdown:
  ready-check: 8 min
  implement: 95 min (50 + 30 + 15 across 3 attempts)
  code-review: 23 min (10 + 8 + 5 across 3 attempts)
  qa: 20 min (15 + 5 across 2 attempts)
  docs: 15 min (10 reject + 5 pass)
  po-accept: 10 min
  deploy: 15 min
  
rejections:
  - Code Review: Missing error handling (fixed in cycle 1)
  - Docs: API docs missing (fixed in cycle 2)
```

### Key Observations

1. **TDD Worked:** Tests written first in initial implementation, caught by code review
2. **Fast Feedback:** Code review rejection happened 10 min after implementation complete
3. **Specific Feedback:** Each rejection had concrete, actionable blockers
4. **Learning Signal:** Agent patterns visible (error handling gap, docs oversight)
5. **Lead Time:** 2.5 hours from commit to production (well under 1-day target)
6. **Rejection Normal:** 2 cycles is acceptable; feedback was fast and task completed successfully

---

## Appendix: Comparison to Human SDLC

| Aspect | Human SDLC | Agentic SDLC |
|--------|-----------|--------------|
| **Task Size** | Days to weeks | Hours (<4) |
| **Context Retention** | Developers remember discussions, decisions | All context in task frontmatter |
| **Code Review** | Async + sync (comments + pairing) | Async only (too expensive to pair) |
| **Feedback Loop** | Hours to days | Minutes to hours (target: <30 min per gate) |
| **Testing** | Sometimes post-implementation | TDD mandatory (enforced at code review) |
| **Rejection** | Stigmatized (performance issue) | Signal (learning data) |
| **Escalation** | Manual ("hey, I'm stuck") | Automatic (timeout-based) |
| **Retrospectives** | Meetings every 2 weeks | Automated, continuous analysis |
| **Deployment** | Coordinated releases | Continuous (multiple per day) |
| **Ceremonies** | Standups, planning, retros | None (metrics replace ceremonies) |

---

## Appendix: Open Questions for PO/PM

1. **WIP Limits Calibration:**
   - Are proposed limits (5 implement, 3 review, etc.) realistic for initial agent capacity?
   - Should limits be dynamic (adjusted based on throughput metrics)?

2. **Rejection Tolerance:**
   - What rejection rate is acceptable? (Proposed: <40% per gate sustained)
   - At what point does high rejection rate trigger process review vs agent training?

3. **Escalation Thresholds:**
   - Are timeout SLAs realistic? (60 min code review, 120 min QA, etc.)
   - Should timeouts scale with task complexity (larger tasks get more time)?

4. **Dead-Letter Handling:**
   - Who is responsible for dead-letter queue review? (PM weekly, PO monthly?)
   - What's the process for resurrecting or canceling stuck tasks?

5. **Conditional Gate Expansion:**
   - Should there be additional conditional gates? (UX review for frontend, performance review for data-heavy tasks?)
   - How do we prevent "gate proliferation" (too many gates = slow pipeline)?

6. **Agent Capacity Planning:**
   - How many agents per role do we need for target throughput?
   - Should we dynamically spawn agents based on queue depth?

7. **Metrics Dashboard:**
   - What metrics are most important for PO visibility? (Lead time, deployment frequency, rejection rate?)
   - How often should retrospectives run? (Weekly for PM, monthly for PO?)

---

## Conclusion

This agentic SDLC design achieves all stated requirements:

✅ **XP + Continuous Delivery:** TDD mandatory, trunk-based, small batches, continuous integration  
✅ **Optimized for Agents:** Context travels with task, small sessions, variable capability support, async review  
✅ **Learning Loops:** Rejection feedback immediate, metrics drive improvement, automated retros  
✅ **Automated Governance:** PO/PM/Architect are gate owners, AOF enforces progression  
✅ **Quality & Security:** Every task through QA, security review conditional, test coverage enforced  
✅ **Documentation:** Tech writer gate for docs-tagged work, API changes trigger docs review  
✅ **Code Review:** Architect reviews all code, TDD enforcement, rejection with specific feedback  
✅ **Anti-Stall:** Timeout-based escalation, PM monitoring, dead-letter handling, no task forgotten  
✅ **Accelerate Principles:** Lead time, deployment frequency, change failure rate, MTTR tracked  
✅ **Agile Concepts:** Backlog grooming, sprint planning, retrospectives (automated), WIP limits  
✅ **Deployment Flows:** SRE-owned deploy gate, conditional based on project type  

**Next Steps:**
1. Review this design with PO/PM
2. Resolve open questions (WIP limits, timeouts, escalation)
3. Begin implementation of Workflow Gates primitive (separate task)
4. Pilot this SDLC on AOF project itself (meta: use the workflow to build the workflow)

---

**Document Status:** READY FOR REVIEW  
**Approvers:** PO, PM  
**Implementation Blocking:** Workflow Gates primitive implementation (separate task)
