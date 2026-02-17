Task Brief

Beads Task ID: AOF-cz0

Objective
Investigate why Project Xray Mule container became unreachable after lease TTL change; produce recovery plan and rollback/mitigation steps for ops.

Scope
- Gather relevant runtime logs/config history around lease TTL change (config repo, deployment diff, platform logs).
- Identify failure mode (e.g., lease expiry, service discovery, networking, container lifecycle).
- Propose recovery steps (immediate mitigation) and a safer configuration/rollback plan.
- Document findings and recommended runbook updates.

Acceptance Criteria
- Clear root cause hypothesis backed by evidence (logs/configs).
- Step-by-step recovery plan (immediate actions) and rollback/mitigation options.
- Risks/side effects noted for each option.
- Summary comment suitable to paste into AOF task.

Out of Scope
- Implementing code changes or config changes (recommendations only).

Dependencies
- Access to Xray deployment/config logs and lease TTL change record.

Estimated Tests
- 0 (investigation only).
