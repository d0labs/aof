# Phase 1.5 Recovery Hardening (P2) - Tech Writer Assignments

This supports: **AOF-r7b**, **AOF-8cq**, **AOF-br2**, **AOF-tzd**, **AOF-1m9**. P3 tasks deferred.

## Objective
Produce recovery runbooks and operator guides for new opt-in recovery hardening features: watchdog health monitoring, CLI recovery hook, deadletter handling/resurrection, SLA primitive, and deadletter alerting.

## Scope
- Update operator docs/runbooks to include:
  - How to enable/disable watchdog monitoring
  - Using `--recover-on-failure` and expected behaviors
  - Deadletter lifecycle: causes, detection, and resurrection command usage
  - SLA primitive: what it means, how to set, defaults
  - Alerting for deadletters: configuration, routing, and example messages
- Include “opt-in only” disclaimers and compatibility notes.

## Acceptance Criteria
- Clear steps for enabling/disabling each feature
- Safety warnings for recovery actions and resurrection
- Examples for CLI commands and sample alerts
- Notes on ejectable design philosophy (features removable, no hard dependency)

## Out of Scope
- P3 MCP integrations
- Deep internal architecture diagrams unless requested

## Dependencies
- Backend final interfaces/CLI flags and alert payloads

## Estimated Docs
- 2–3 sections or pages (runbook + operator guide), with updated CLI reference snippets
