# AOF Documentation

**Agent Orchestration Framework (AOF)** -- Multi-agent task orchestration with workflow gates, org charts, and deterministic routing. AOF ensures tasks never get dropped: they survive restarts, API failures, and agent crashes, always resuming and completing end-to-end.

This index is organized by audience: **User Guide** for operators and integrators, **Developer Guide** for contributors and architects.

---

## User Guide

End-user documentation for deploying, configuring, and operating AOF.

- [Getting Started](guide/getting-started.md) -- Install AOF, configure it, and run your first task
- [Configuration Reference](guide/configuration.md) -- Org-chart schema, AOF config options, and OpenClaw plugin wiring
- [CLI Reference](guide/cli-reference.md) -- Auto-generated reference for all AOF commands
- [Deployment Guide](guide/deployment.md) -- Set up AOF as an OpenClaw plugin or standalone daemon
- [Workflow Gates User Guide](guide/workflow-gates.md) -- Define and use multi-stage workflow gates with review loops
- [Task Format](guide/task-format.md) -- Task file structure and frontmatter schema
- [Protocols User Guide](guide/protocols.md) -- Inter-agent protocols: handoff, resume, status update, completion
- [Memory Module](guide/memory.md) -- HNSW vector search, embeddings, curation, and memory tools
- [SLA Guide](guide/sla.md) -- SLA configuration, alerting, and tuning
- [Notification Policy](guide/notifications.md) -- Channel routing, deduplication, and storm batching
- [Event Logs](guide/event-logs.md) -- Date-rotated JSONL event stream and audit trail
- [Recovery Runbook](guide/recovery.md) -- Troubleshooting and incident response procedures
- [CLI Recovery Reference](guide/cli-recovery.md) -- Quick reference for recovery CLI commands
- [Migration Guide](guide/migration.md) -- Upgrade from legacy layout to Projects v0
- [Known Issues](guide/known-issues.md) -- Current limitations and workarounds
- [Task Lifecycle](guide/task-lifecycle.md) -- How tasks move through AOF's state machine
- [Org Charts](guide/org-charts.md) -- Declarative YAML definitions for agents, teams, roles, and routing
- [Cascading Dependencies](guide/cascading-dependencies.md) -- Automatic propagation of task completions to dependents
- [Custom Gates](guide/custom-gates.md) -- Design workflow gates for your specific process
- [Agent Tools](guide/agent-tools.md) -- Complete reference for all AOF tools available to agents

---

## Developer Guide

Contributor documentation, architecture decisions, and design specifications.

### Contributing

- [Dev Workflow](dev/dev-workflow.md) -- Fast-feedback development loop for AOF contributors
- [Dev Tooling Guide](dev/dev-tooling.md) -- Release automation, commit conventions, and git hooks
- [Engineering Standards](dev/engineering-standards.md) -- Code quality and module structure rules
- [Refactoring Protocol](dev/refactoring-protocol.md) -- Mandatory protocol for safe incremental refactoring
- [Agent Instructions](dev/agents.md) -- Task workflow for agents contributing to AOF
- [Definition of Done](dev/definition-of-done.md) -- What "complete" means for AOF tasks
- [Release Checklist](dev/release-checklist.md) -- Step-by-step process for cutting a release
- [Roadmap](dev/roadmap.md) -- Project roadmap and milestone tracking

### Architecture & Design

- [Architecture Overview](dev/architecture.md) -- System architecture, subsystem descriptions, and key interfaces
- [Workflow Gates Design](dev/workflow-gates-design.md) -- Technical architecture and gate evaluation internals
- [Protocols Design](dev/protocols-design.md) -- Protocol envelope format and router design
- [Protocols BDD Specs](dev/protocols-bdd-specs.md) -- Behavior-driven protocol specifications
- [Memory Module Plan](dev/memory-module-plan.md) -- Memory v2 architecture: embeddings, SQLite-vec, tiered memory
- [Tiered Memory Pipeline](dev/memory-tier-pipeline.md) -- Hot/warm/cold tier curation and retrieval pipeline
- [SLA Primitive Design](dev/sla-primitive-design.md) -- SLA tracking and enforcement internals
- [Agentic SDLC Design](dev/agentic-sdlc-design.md) -- Reference multi-agent SDLC workflow built on AOF
- [Daemon Watchdog Design](dev/daemon-watchdog-design.md) -- Health monitoring and self-healing daemon
- [Adaptive Concurrency](dev/adaptive-concurrency.md) -- Platform limit detection and concurrency tuning
- [E2E Test Harness Design](dev/e2e-test-harness.md) -- End-to-end test harness architecture
- [Security Remediation Design](dev/security-remediation.md) -- Protocol security hardening

---

## Examples

Example workflow definitions demonstrating AOF capabilities.

- [simple-review.yaml](examples/simple-review.yaml) -- Minimal 2-gate workflow for small teams
- [swe-sdlc.yaml](examples/swe-sdlc.yaml) -- Full 9-gate SWE workflow with conditionals
- [sales-pipeline.yaml](examples/sales-pipeline.yaml) -- Non-SWE example demonstrating domain neutrality

---

## Quick Reference

| Task | Document |
|------|----------|
| Get started | [Getting Started](guide/getting-started.md) |
| Configure AOF | [Configuration Reference](guide/configuration.md) |
| Set up AOF | [Deployment Guide](guide/deployment.md) |
| Create a workflow | [Workflow Gates User Guide](guide/workflow-gates.md) |
| Understand task files | [Task Format](guide/task-format.md) |
| Debug a stuck task | [Recovery Runbook](guide/recovery.md) |
| Send agent protocols | [Protocols User Guide](guide/protocols.md) |
| Configure memory | [Memory Module](guide/memory.md) |
| Understand task states | [Task Lifecycle](guide/task-lifecycle.md) |
| Define your org chart | [Org Charts](guide/org-charts.md) |
| Design custom gates | [Custom Gates](guide/custom-gates.md) |
| Agent tool reference | [Agent Tools](guide/agent-tools.md) |
| Cut a release | [Release Checklist](dev/release-checklist.md) |
| Start contributing | [Dev Workflow](dev/dev-workflow.md) |
