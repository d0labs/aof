# AOF Documentation

**Agent Orchestration Framework (AOF)** — Multi-agent task orchestration with workflow gates, org charts, and deterministic routing.

---

## Getting Started

- **[Quick Start](P2.1-quick-start.md)** — Get up and running in 5 minutes
- **[Definition of Done](DEFINITION-OF-DONE.md)** — What "complete" means for AOF tasks
- **[Migration Guide](migration-guide.md)** — Upgrade from previous versions

---

## Core Features

### Workflow Gates

**NEW:** Multi-stage process enforcement with review gates, rejection loops, and conditional progression.

- **[Workflow Gates User Guide](WORKFLOW-GATES.md)** ⭐ **Start here** — Complete guide to defining and using workflows
- **[Design Document](design/WORKFLOW-GATES-DESIGN.md)** — Technical architecture and design decisions

**Examples:**
- [simple-review.yaml](examples/simple-review.yaml) — Minimal 2-gate workflow for small teams
- [swe-sdlc.yaml](examples/swe-sdlc.yaml) — Full 9-gate SWE workflow with conditionals
- [sales-pipeline.yaml](examples/sales-pipeline.yaml) — Non-SWE example (demonstrates domain neutrality)

### Murmur Orchestration

**Team-scoped orchestration trigger system** for automated review cycles and team coordination.

Murmur monitors team task queues and automatically spawns orchestration review tasks based on configurable triggers (queue empty, completion batches, time intervals, failure thresholds). This enables periodic team health checks, sprint retrospectives, and capacity planning without manual intervention.

**Key capabilities:**
- **Declarative triggers** — Configure when orchestration reviews should fire
- **Stateful evaluation** — Tracks completions, failures, and review history per team
- **Idempotency guarantees** — Never spawns concurrent reviews for the same team
- **Stale review cleanup** — Automatically recovers from hung orchestrator sessions

**Configuration:** See [Deployment Guide: Murmur Orchestration Configuration](DEPLOYMENT.md#murmur-orchestration-configuration)

### Task Management

- **[Beads Integration](BEADS-INTEGRATION.md)** — Task lifecycle and status management
- **[Task Format](task-format.md)** — Task file structure and frontmatter schema
- **[SLA Guide](SLA-GUIDE.md)** — Service-level agreement tracking

### Organization

- **Org Charts** — Role-based agent assignment and routing (see [Workflow Gates User Guide](WORKFLOW-GATES.md#org-chart-role-mapping))
- **Agent Roles** — Map abstract roles to concrete agents

### Memory & Context

- **[Memory V2 Scoping](memory-v2-scoping.md)** — Context and memory management architecture
- **[Memory Medallion Pipeline](memory-medallion-pipeline.md)** — Data curation and retrieval
- **[Context Engineering](CONTEXT-ENGINEERING-ALIGNMENT.md)** — Optimizing agent context

---

## Architecture & Design

### Core Systems

- **[Protocols Design](PROTOCOLS-DESIGN.md)** — Inter-agent communication protocols
- **[Protocols User Guide](PROTOCOLS-USER-GUIDE.md)** — How to use AOF protocols
- **[Projects Architecture](PROJECTS-ARCHITECTURE-ASSESSMENT.md)** — Multi-project management
- **[E2E Test Harness](E2E-TEST-HARNESS-DESIGN.md)** — End-to-end testing framework

### Infrastructure

- **[Deployment Guide](DEPLOYMENT.md)** — Production deployment and configuration
- **[Daemon Watchdog](DAEMON-WATCHDOG-DESIGN.md)** — Health monitoring and recovery
- **[Recovery Runbook](RECOVERY-RUNBOOK.md)** — Troubleshooting and incident response
- **[CLI Recovery Reference](CLI-RECOVERY-REFERENCE.md)** — Command-line recovery procedures

---

## Development

### Planning & Process

- **[Roadmap: Platform Leverage](ROADMAP-PLATFORM-LEVERAGE.md)** — Future features and OpenClaw integration opportunities
- **[Integration Plan](INTEGRATION-PLAN.md)** — Component integration strategy
- **[Plugin Integration Status](PLUGIN-INTEGRATION-STATUS.md)** — OpenClaw plugin integration progress

### Testing

- **[E2E Test Harness Executive Summary](E2E-TEST-HARNESS-EXECUTIVE-SUMMARY.md)** — Testing strategy overview
- **[Protocols BDD Specs](PROTOCOLS-BDD-SPECS.md)** — Behavior-driven development specs
- **[Test Plans](test-plans/)** — Detailed test plans and QA documentation

### Implementation Summaries

- **[P2.1 Implementation Summary](P2.1-implementation-summary.md)** — Phase 2.1 delivery summary
- **[Task Completion Analysis](TASK-COMPLETION-ANALYSIS.md)** — Task workflow analysis

---

## Operations

### Monitoring & Observability

- **[SLA Primitive Design](SLA-PRIMITIVE-DESIGN.md)** — SLA tracking and enforcement
- **[Event Logs](event-logs.md)** — Event stream documentation
- **[Notification Policy](notification-policy.md)** — Alert and notification routing

### Security

- **[Security Remediation Design](SECURITY-REMEDIATION-DESIGN.md)** — Security hardening and remediation

### Known Issues

- **[Known Issues](KNOWN-ISSUES.md)** — Current limitations and workarounds

---

## Project Management

### Reviews & Assessments

- **[Projects PM Review](PROJECTS-PM-REVIEW.md)** — Project management assessment
- **[Projects PO Review](PROJECTS-PO-REVIEW.md)** — Product owner review and feedback
- **[Projects Arch Review V2](PROJECTS-ARCH-REVIEW-v2.md)** — Architecture review
- **[Process Gaps](process-gaps.md)** — Identified process improvements

### Specifications

- **[Projects V0 Spec](PROJECTS-V0-SPEC.md)** — Initial project management specification
- **[Projects V0 Implementation Design](PROJECTS-V0-IMPLEMENTATION-DESIGN.md)** — Implementation design

---

## Context & Analysis

- **[Context Engineering AI Analysis](CONTEXT-ENGINEERING-AI-ANALYSIS.md)** — AI-driven context optimization analysis
- **[Context Engineering Update Summary](CONTEXT-ENGINEERING-UPDATE-SUMMARY.md)** — Context system updates
- **[Reconciliation Summary](reconciliation-summary.md)** — System state reconciliation

---

## Additional Resources

- **[Mailbox View](mailbox-view.md)** — Inter-agent mailbox coordination
- **[Daemon CLI Integration](daemon-cli-integration-summary.md)** — CLI and daemon integration
- **[Memory Adapter Spec](MEMORY-ADAPTER-SPEC.md)** — Memory storage adapter specification
- **[Memory Integration Architecture](MEMORY-INTEGRATION-ARCHITECTURE.md)** — Memory system architecture
- **[OpenClaw Feature Opportunities](OPENCLAW-FEATURE-OPPORTUNITIES.md)** — Platform feature requests

---

## Quick Links

| Topic | Document |
|-------|----------|
| **Getting started** | [Quick Start](P2.1-quick-start.md) |
| **Create workflows** | [Workflow Gates User Guide](WORKFLOW-GATES.md) |
| **Manage tasks** | [Beads Integration](BEADS-INTEGRATION.md) |
| **Deploy to production** | [Deployment Guide](DEPLOYMENT.md) |
| **Troubleshooting** | [Recovery Runbook](RECOVERY-RUNBOOK.md) |
| **Design reference** | [Protocols Design](PROTOCOLS-DESIGN.md) |

---

**Version:** 1.0  
**Last Updated:** 2026-02-17  
**Test Suite:** 1752 tests (164 files)
