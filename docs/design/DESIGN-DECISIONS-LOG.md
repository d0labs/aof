> **Internal document** — context-specific details may not apply to general deployments.

# Workflow Gates + Agentic SDLC: Design Decisions Log

**Date:** 2026-02-16  
**Participants:** AOF core team

---

## Non-Negotiable Design Constraints

### C1: Dumb Agents Must Thrive
An agent with zero AOF training and modest capability must get massive value out of the box. Trained agents do better naturally, but the system optimizes for the dumb case. If an agent needs to read docs to use AOF, the design has failed.

**Implications:** Tool descriptions teach usage. Task context teaches the gate. Errors are actionable. Config is self-documenting. No context pollution.

### C2: Executable Test Specs (Design for Now, Build Later)
Frontmatter test specs should be designed with future executability in mind. BDD-style structured AC now, runnable test contracts later. Don't paint into a corner.

### C3: Teaching Without Context Pollution
AOF must teach agents how to use it idiomatically without injecting walls of instructions. The mechanism: tool descriptions > per-task gate context > helpful errors > optional cheatsheet (escalating, not all-at-once).

---

## V1 Decisions (Build Now)

### D1: Gate History Storage
**Decision:** Frontmatter  
**Rationale:** Single source of truth, atomic updates, simpler queries

### D2: Gate Timeouts with Auto-Escalation  
**Decision:** Include in v1, keep automation "dumb" (timeout → escalate to next in chain)  
**Tightened values:**
- Review gates (code-review, QA, security, docs, po-accept): **1 hour**
- Implementation gate: **2 hours**
- Ready-check: **30 min** (unchanged)
- Deploy: **45 min** (unchanged)
**Rationale:** Agents work continuously, not humans. 4hr timeouts are too generous.

### D3: Human-Only Approval Gates
**Decision:** Include in v1  
**Use case:** PO acceptance, final sign-off gates  
**Mechanism:** `requireHuman: true` flag on gate config

### D4: Rejection Routing
**Decision:** All rejections → implement (v1)  
**Rationale:** Simple, covers most cases. Open to ideas for v2 if patterns emerge.

### D5: Anti-Stall Cascade  
**Decision:** Tighten thresholds to match agent work patterns (not human patterns)  
**Values:** 1hr review, 2hr implement (down from 4hr/8hr in PM addendum)

### D6: Project Primitive for Sprint Management
**Decision:** PM process MUST leverage the existing `project` primitive  
**The `project` primitive is feature-complete and should serve as:**
- Epic / unit of sprint measure
- Sprint planning container
- Sprint review scope (demo deliverables to human)
- Sprint retro scope (self-enhancement, feedback, process improvement suggestions)
- Sprint refinement scope
**Gap:** PM addendum doesn't reference this at all. Needs update.

### D7: Concurrency Respects Platform
**Decision:** WIP model must integrate with AOF's adaptive concurrency  
**Context:** AOF already has `maxConcurrentDispatches` and platform limit detection. WIP limits in PM design must work WITH these, not independently.

---

## Wishlist / V2

### W1: Parallel Gates
**What:** Run security + docs + QA simultaneously instead of sequentially  
**Why deferred:** Fork/join logic is complex, latency isn't a concern right now  
**Document in:** `~/Projects/AOF/docs/ROADMAP-PLATFORM-LEVERAGE.md`

### W2: Self-Review Gate (Same Agent Type, New Session)
**What:** Before architect code-review, have another instance of the same agent type review in a fresh session  
**Why:** Fresh eyes catch different issues than the original implementer  
**Challenge:** May be hard to accomplish through plugin or plain AOF — needs design  
**Value:** High — catches "author blindness" before expensive architect review

### W3: Human-in-the-Loop
**What:** Allow humans to pair with agents OR fulfill an entire role  
**Use cases:** Training new agents, high-stakes decisions, creative work  
**Challenge:** Needs mechanism to pause workflow and wait for human input

### W4: BDD Integration
**What:** Behavior-Driven Development with Given/When/Then specs  
**Analysis:** BDD-style AC is MORE useful for agents (structured, unambiguous, directly translatable to test code). But full Cucumber/Gherkin tooling is overhead.  
**Recommendation:** Use BDD-style acceptance criteria in task frontmatter NOW (structured AC format gets 80% of value). Defer full BDD tooling to v2.

### W5: Workflow Templates for Distribution
**What:** When AOF is packaged for sharing, include ready-made workflow templates (SDLC, sales pipeline, content publishing, compliance, etc.) that users can drop into their project.yaml.
**Value:** Lowers barrier to adoption. Users get working workflows out of the box.

### W6: Recursive Teams — Org-Level Workflows
**What:** Same workflow gates primitive, but actors can be **teams** instead of agents. An org-level workflow assigns gates to teams; a team's orchestrator agent decomposes org tasks into team-level tasks with their own workflow. Completion rolls up.

**Example:**
```
Org workflow:  plan → engineering → marketing → launch
                         ↓
               Engineering team workflow:  implement → review → QA → done
                                              ↓
                                     Agent does the work
```

**Key design points:**
- Org chart gets `type: team` vs `type: agent` on roles
- A team's "completion" = all its internal tasks reach done
- Org-level rejection sends back to the team, not individual agents
- Same primitive at every level (recursive)
- One agent per team is the orchestrator (receives org tasks, decomposes into team tasks)
- Cross-team projects: org-level tasks span multiple teams, each team follows its own workflow

**Why it simplifies AOF:** Instead of special orchestration logic for multi-team coordination, you just recurse workflow gates. The org chart IS the hierarchy. Workflows compose naturally.

**Status:** Defer to v2. Needs careful design — must be done right. But the current gate primitive should be designed so it doesn't preclude this (e.g., don't hardcode "agent" as the only actor type).

**Sub-requirements:**
- **Ingest point:** Org chart must declare per-team who receives new work (`ingest: po`). That agent is responsible for decomposing projects into tasks, setting AC, tagging, and feeding into the workflow. This is a role behavior, not an AOF mechanism — AOF just routes to the ingest agent.
- **Project-level gates:** Projects themselves could flow through gates (proposal → approved → in-progress → review → shipped) where actors are teams or senior agents. Depends on recursive teams. Longer-term (v3?).

### W7: Org Chart Auto-Population
**What:** Easy/automated way to generate an org chart. Multiple sources:
1. **OpenClaw deployments:** Auto-generate from `openclaw.json` agent list (map agent IDs to roles by naming convention or config hints). This is just ONE option — AOF must not be coupled to OpenClaw.
2. **Non-OpenClaw deployments:** Template-based. Ship starter templates (SWE team, sales team, content team) that users customize.
3. **Manual:** Write org.yaml by hand (current approach).

**UX challenge:** How does the user experience this? Options:
- `aof init` wizard that asks questions and generates org.yaml
- `aof org generate --from-openclaw` for OpenClaw users
- `aof org generate --template swe` for template-based
- Or: AOF detects it's running as an OpenClaw plugin and offers to auto-generate on first run

**Key constraint:** AOF must not import or depend on OpenClaw internals. The OpenClaw adapter can provide agent list to AOF via a platform-agnostic interface.

**Sub-requirements:**
- **AOF must work without org chart.** No org chart = basic task management (explicit agent routing, no gates, no role mapping). Still useful as a task queue with leases/heartbeats/completion. Org chart + workflow gates are progressive enhancement, not prerequisite.
- **Impossible to miss:** When AOF detects no org chart:
  1. First `aof_dispatch` response includes nudge: "Tip: No org chart found. Run `aof org generate` for role-based routing and workflow gates."
  2. OpenClaw adapter: auto-generate starter org.yaml from agent list on first run if none exists (log it, don't silently create)
  3. `aof status` always shows: "Org chart: not configured (basic mode)" vs "Org chart: N agents across M roles"
  4. Never block — always nudge. AOF works without it but reminds you there's more.

### W8: AOF Native Harness (Platform Independence)
**What:** Build a standalone agentic harness/platform. AOF remains AOF — the orchestration fabric (workflow gates, protocol, scheduling, org charts). The harness is a SEPARATE component providing the runtime: gateway, agent sessions, tool execution, model routing, security. AOF is a core high-level component within the harness, not the harness itself.
**Naming:** TBD. Platform name undecided. AOF = orchestration fabric. Harness = runtime infrastructure. Platform = the whole thing.
**Why:** Full control over the stack. No coupling to OpenClaw's limitations (maxChildrenPerAgent, tool visibility bugs, session management quirks). Our own extensible harness with high-level abstractions.
**Components to build or integrate:**
- Gateway: request routing, auth, rate limiting (Envoy? custom?)
- Agent runtime: session management, tool execution, model routing (LiteLLM, direct SDKs)
- Control plane: scheduler, workflow engine, org chart, protocol — **already AOF core**
- Observability: structured events, metrics, tracing (OpenTelemetry)
- Security: sandboxing, secrets (Vault?), audit trail
- Durable execution: Temporal, Inngest, or custom for long-running workflows
**Key insight:** Everything we're building now (workflow gates, protocol, adaptive concurrency, org charts) IS the control plane. The OpenClaw adapter is the thinnest layer. When we build our own harness, we swap that layer — the intelligence stays.
**Status:** Long-term roadmap. Massive effort but the architecture is already being designed platform-agnostic. Every decision we make now should keep this path open.
**Open source leverage:** LiteLLM (model routing), Temporal/Inngest (durable execution), OpenTelemetry (observability), HashiCorp Vault (secrets), Envoy (gateway). Don't reinvent what exists.

### W9: Metrics & Observability
**What:** DORA metrics, gate-specific metrics, agent performance tracking  
**Challenge:** Must be platform-agnostic. Can't inject custom instructions into platform agents easily. Would need a dedicated metrics agent inspecting AOF logs, or AOF emitting structured events that any platform can consume.  
**Approach:** AOF already emits JSONL events. A metrics agent could analyze these. But designing the agent + making it work across platforms is a hard problem.  
**Recommendation:** Start with AOF emitting richer structured events (gate transitions, rejections, durations). Defer the analysis/dashboard layer.

---

## Open Questions (Resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | Gate history storage | Frontmatter |
| 2 | Parallel gates | Defer v2 |
| 3 | Gate timeouts | Automation now, dumb v1 |
| 4 | Human approval gates | v1 |
| 5 | Rejection routing | All → implement (v1) |
| 6 | Anti-stall thresholds | 1hr review, 2hr implement |
| 7 | Project primitive | Must be used for sprint mgmt |
