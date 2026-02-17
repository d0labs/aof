# Workflow Gates Phase 1 — Implementation Task Breakdown

**Scope:** Core Primitive MVP (schemas → logic → integration)  
**Source:** `WORKFLOW-GATES-DESIGN.md` + `DESIGN-DECISIONS-LOG.md`

This document enumerates Phase 1 tasks in dependency order and links to backend briefs.

---

## Implementation Tasks (Ordered by Dependency)

1. **AOF-jax — Core schema types (Gate, GateHistory, ReviewContext, TestSpec)**  
   - **Brief:** `mailbox/swe-backend/inbox/20260216-230000-WG-Core-Schema-Types.md`

2. **AOF-60p — Extend Task frontmatter schema with gate fields** *(depends on AOF-jax)*  
   - **Brief:** `mailbox/swe-backend/inbox/20260216-230200-WG-Task-Schema-Extension.md`

3. **AOF-snk — Org chart schema extension for gates**  
   - **Brief:** `mailbox/swe-backend/inbox/20260216-230100-WG-Org-Chart-Schema-Extension.md`

4. **AOF-bko — Workflow config schema + validation** *(depends on AOF-jax)*  
   - **Brief:** `mailbox/swe-backend/inbox/20260216-230300-WG-Workflow-Config-Schema.md`

5. **AOF-xak — Conditional gate evaluator (when expressions)** *(depends on AOF-jax)*  
   - **Brief:** `mailbox/swe-backend/inbox/20260216-230400-WG-Conditional-Gate-Evaluator.md`

6. **AOF-acq — Gate evaluation algorithm (core logic)** *(depends on AOF-jax, AOF-bko)*  
   - **Brief:** `mailbox/swe-backend/inbox/20260216-230500-WG-Gate-Evaluation-Algorithm.md`

7. **AOF-g89 — Extend `aof_task_complete` tool with outcomes** *(depends on AOF-60p)*  
   - **Brief:** `mailbox/swe-backend/inbox/20260216-230800-WG-Tool-Extension-Outcomes.md`

8. **AOF-yt8 — Validation errors + helpful messages** *(depends on AOF-g89)*  
   - **Brief:** `mailbox/swe-backend/inbox/20260216-232000-WG-Validation-Errors-Helpful-Messages.md`

9. **AOF-ofi — Gate context injection for task payloads** *(depends on AOF-bko)*  
   - **Brief:** `mailbox/swe-backend/inbox/20260216-230900-WG-Gate-Context-Injection.md`

10. **AOF-9eq — Scheduler gate transition handler** *(depends on AOF-60p, AOF-bko, AOF-acq, AOF-xak)*  
    - **Brief:** `mailbox/swe-backend/inbox/20260216-230600-WG-Scheduler-Gate-Transition-Handler.md`

11. **AOF-69l — Gate timeout detection + auto-escalation** *(depends on AOF-9eq)*  
    - **Brief:** `mailbox/swe-backend/inbox/20260216-230700-WG-Gate-Timeout-Detection.md`

12. **AOF-mmd — Gate telemetry (Prometheus metrics)** *(depends on AOF-9eq)*  
    - **Brief:** `mailbox/swe-backend/inbox/20260216-232100-WG-Gate-Telemetry-Metrics.md`

---

## QA / Verification Tasks

- **AOF-9vl — Unit tests for gate evaluator** *(depends on AOF-acq, AOF-xak)*  
  - **Brief:** `mailbox/swe-backend/inbox/20260216-232200-WG-Gate-Evaluator-Unit-Tests.md`

- **AOF-27d — Integration tests for gate progression** *(depends on AOF-9eq, AOF-69l, AOF-g89, AOF-ofi, AOF-yt8, AOF-mmd)*  
  - **Brief:** _TBD_ (create QA brief if needed)

---

## Notes

- Backend briefs exist for all implementation tasks in `mailbox/swe-backend/inbox/`.
- If PM requires **QA task per implementation task**, create additional QA beads tasks and briefs (not yet generated).
