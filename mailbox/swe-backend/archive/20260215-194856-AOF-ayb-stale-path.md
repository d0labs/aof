Beads Task ID: AOF-ayb
Objective:
Fix scheduler TaskContext building so taskPath reflects the post-lease (in-progress) location, avoiding ENOENT on first read.

Scope:
- Locate scheduler code that builds TaskContext before acquireLease/transition.
- Adjust to build context after lease acquisition, or switch to id-based lookup that resolves current path.
- Update any tests or add a regression test for ready→in-progress transition.

Acceptance Criteria:
- Agent receives a TaskContext.taskPath that points to the correct file after transition.
- No ENOENT when first reading task file immediately after lease.

Out of Scope:
- Broad refactors of scheduler; keep change minimal.

Dependencies:
- None.

Estimated Tests:
- 1–2 scheduler/unit tests for task path after lease.
