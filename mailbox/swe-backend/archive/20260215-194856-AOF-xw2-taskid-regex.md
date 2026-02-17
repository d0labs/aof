Beads Task ID: AOF-xw2
Objective:
Fix TaskId validation to accept subtask IDs with optional "-NN" suffix (e.g., TASK-2026-02-15-002-01) while preserving current main ID format.

Scope:
- Locate the TaskId zod schema (likely in validation/schema utilities).
- Update regex to allow optional -NN suffix: ^TASK-\d{4}-\d{2}-\d{2}-\d{3}(-\d{2})?$ (or equivalent).
- Update/extend any unit tests covering TaskId validation.

Acceptance Criteria:
- IDs like TASK-2026-02-15-002 validate successfully.
- IDs like TASK-2026-02-15-002-01 validate successfully.
- Invalid formats still fail (e.g., wrong prefix, wrong digit counts).

Out of Scope:
- Changes to TaskId generation logic (only validation).

Dependencies:
- None.

Estimated Tests:
- 1–2 unit tests for validation schema.
