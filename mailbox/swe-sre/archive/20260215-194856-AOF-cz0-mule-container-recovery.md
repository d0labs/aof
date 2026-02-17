Beads Task ID: AOF-cz0
Objective:
Investigate why Project Xray Mule container became unreachable after lease TTL config change and produce a recovery/mitigation plan.

Scope:
- Identify the lease TTL change and its rollout context.
- Determine failure mode (network, auth, lease expiry, container restart loop).
- Propose immediate recovery steps (rollback/override) and longer-term fix.
- Capture any monitoring/alerting gaps.

Acceptance Criteria:
- Recovery plan with concrete steps and owner-ready action list.
- Root cause hypothesis with evidence or data sources to check.

Out of Scope:
- Implementing infra changes (unless trivial/approved).

Dependencies:
- Access to logs/metrics for Project Xray Mule container.

Estimated Tests:
- 0 (ops investigation).
