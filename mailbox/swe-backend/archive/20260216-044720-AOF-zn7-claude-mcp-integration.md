Task Brief

Beads Task ID: AOF-zn7

Objective
Define the backend integration plan for AOF MCP server so Claude Code can act as client: task pickup, context ingest (inputs/), subagent spawning, outputs writing. Produce architecture + interface plan.

Scope
- Review current AOF tool interfaces and any MCP server scaffolding (if any).
- Propose MCP server endpoints/tools mapping to AOF actions (task list/claim/close, inputs/outputs read/write, subagent spawn hooks).
- Identify required auth/security, rate limits, and runbook impacts.
- Provide a minimal implementation plan (milestones, files/modules to change) without coding.

Acceptance Criteria
- Architecture diagram/description of MCP server components and tool mappings.
- List of required backend modules/files and new interfaces.
- Clear sequence for Claude Code client workflow (pickup → context → exec → output).
- Risks/open questions captured.

Out of Scope
- Implementation code or frontend work.

Dependencies
- Any existing MCP server code or governance docs in AOF repo (locate and reference).

Estimated Tests
- 0 (design spike).
