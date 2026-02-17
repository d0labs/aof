# Task Brief: Add SLA Primitive to Task Schema

**Beads Task ID:** AOF-09x  
**Priority:** Phase 1.5 Recovery Hardening  
**Assigned To:** swe-backend  
**Estimate:** 1 person-day  
**Dependencies:** None (ready to start)

---

## Objective

Add SLA configuration to task schema (per-task overrides + per-project defaults in org-chart.yaml). Fields: `maxInProgressMs`, `onViolation`. Defaults: 1hr normal / 4hr research. Phase 1: advisory (alert only).

**Claim this task:** `bd update AOF-09x --claim --json`  
**View details:** `bd show AOF-09x --json`

---

## Context

PO approved Phase 1.5 Recovery Hardening (see `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md` §4). Tasks should have configurable time limits to detect stalls. SLA primitive is the schema foundation; scheduler integration happens in AOF-ae6 (separate task).

**Design Doc:** `~/Projects/AOF/docs/design/SLA-PRIMITIVE-DESIGN.md` (READ THIS FIRST)

---

## Scope

### Files to Create
1. **src/config/sla-defaults.ts** — Default SLA configuration

### Files to Modify
1. **src/types/task.ts** — Add `sla` field to Task interface
2. **src/validation/task-schema.ts** — Add SLA field validation
3. **org-chart.yaml** — Add `sla` section (per-project defaults)

---

## Acceptance Criteria

### Task Schema
- [ ] Task interface includes `sla?: { maxInProgressMs?: number; onViolation?: 'alert' | 'block' | 'deadletter' }`
- [ ] Per-task SLA override in frontmatter: `sla.maxInProgressMs`
- [ ] Per-task violation policy: `sla.onViolation` (Phase 1: only `alert` supported)

### org-chart.yaml Schema
- [ ] Per-project SLA defaults: `defaultMaxInProgressMs`, `researchMaxInProgressMs`
- [ ] Per-project violation policy: `onViolation` (default: `alert`)
- [ ] Alerting config: `alerting.channel`, `alerting.webhook`, `alerting.rateLimitMinutes`

### Validation
- [ ] SLA `maxInProgressMs` min: 60000 (1 minute)
- [ ] SLA `maxInProgressMs` max: 86400000 (24 hours)
- [ ] SLA `onViolation` must be one of: `alert`, `block`, `deadletter`
- [ ] Phase 1 constraint: only `alert` is supported (block/deadletter return validation error)

### Resolution Logic
- [ ] Function `getSLALimit(task, project)` returns effective SLA limit
- [ ] Priority: per-task override > per-agent (research) > per-project default
- [ ] If no config, use hardcoded defaults: 1hr normal, 4hr research

### Defaults
```typescript
const DEFAULT_SLA_CONFIG = {
  defaultMaxInProgressMs: 3600000,      // 1 hour
  researchMaxInProgressMs: 14400000,    // 4 hours
  onViolation: 'alert',
  alerting: {
    rateLimitMinutes: 15,
  },
};
```

---

## Test Requirements

### Unit Tests (8 tests minimum)
1. Task schema includes `sla` field
2. Per-task SLA override is parsed from frontmatter
3. Validation: SLA min 1min, max 24hr
4. Validation: `onViolation` must be `alert|block|deadletter`
5. Phase 1 constraint: `block` and `deadletter` return validation error
6. Resolution logic: per-task override takes precedence
7. Resolution logic: research agent gets 4hr default
8. Resolution logic: fallback to hardcoded defaults if no config

### Integration Tests (2 tests minimum)
1. Create task with SLA override → parse frontmatter → verify `sla.maxInProgressMs` is set
2. Load project config → verify `defaultMaxInProgressMs` is read from org-chart.yaml

**Test Framework:** vitest  
**Run Tests:** `cd ~/Projects/AOF && npx vitest run`

---

## Implementation Notes

### Task Schema Extension
```typescript
// In src/types/task.ts

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  routing?: {
    agent?: string;
    role?: string;
  };
  sla?: {
    maxInProgressMs?: number;  // Per-task override
    onViolation?: 'alert' | 'block' | 'deadletter';
  };
  createdAt: number;
  updatedAt: number;
  // ... existing fields
}
```

### Frontmatter Example
```yaml
---
id: AOF-123
title: Deep research spike
priority: high
routing:
  agent: swe-researcher
sla:
  maxInProgressMs: 14400000  # 4 hours (override default)
  onViolation: alert
---
```

### org-chart.yaml Schema
```yaml
aof:
  projects:
    my-project:
      sla:
        defaultMaxInProgressMs: 3600000      # 1 hour (normal tasks)
        researchMaxInProgressMs: 14400000    # 4 hours (research tasks)
        onViolation: alert
        alerting:
          channel: slack
          webhook: https://hooks.slack.com/...
          rateLimitMinutes: 15
```

### Resolution Logic
```typescript
export function getSLALimit(task: Task, projectConfig: ProjectConfig): number {
  // 1. Per-task override (highest priority)
  if (task.sla?.maxInProgressMs !== undefined) {
    return task.sla.maxInProgressMs;
  }
  
  // 2. Per-agent research SLA (if agent matches research role)
  if (task.routing?.agent === 'swe-researcher') {
    return projectConfig.sla?.researchMaxInProgressMs ?? DEFAULT_SLA_CONFIG.researchMaxInProgressMs;
  }
  
  // 3. Project default
  return projectConfig.sla?.defaultMaxInProgressMs ?? DEFAULT_SLA_CONFIG.defaultMaxInProgressMs;
}
```

### Validation Logic
```typescript
export function validateSLA(sla: Task['sla']): ValidationError[] {
  const errors: ValidationError[] = [];
  
  if (sla?.maxInProgressMs !== undefined) {
    if (sla.maxInProgressMs < 60000) {
      errors.push({ field: 'sla.maxInProgressMs', message: 'Minimum 1 minute (60000ms)' });
    }
    if (sla.maxInProgressMs > 86400000) {
      errors.push({ field: 'sla.maxInProgressMs', message: 'Maximum 24 hours (86400000ms)' });
    }
  }
  
  if (sla?.onViolation !== undefined) {
    const valid = ['alert', 'block', 'deadletter'];
    if (!valid.includes(sla.onViolation)) {
      errors.push({ field: 'sla.onViolation', message: `Must be one of: ${valid.join(', ')}` });
    }
    
    // Phase 1 constraint: only 'alert' is supported
    if (sla.onViolation !== 'alert') {
      errors.push({ field: 'sla.onViolation', message: 'Phase 1: only "alert" is supported' });
    }
  }
  
  return errors;
}
```

---

## Out of Scope

- Scheduler integration (that's AOF-ae6, separate task)
- SLA violation detection (that's AOF-ae6)
- Alert emission (that's AOF-1m9, depends on AOF-p3k)
- CLI command for viewing violations (Phase 2)

**This task is schema-only:** Add fields, validation, resolution logic. No runtime behavior.

---

## Definition of Done

1. All acceptance criteria met
2. All unit tests pass (`npx vitest run`)
3. All integration tests pass
4. Code reviewed by architect (tag @swe-architect in commit/PR)
5. Schema documentation updated (if we have a schema doc)
6. Task closed: `bd close AOF-09x --json`

---

## Questions?

If you need clarification, leave a message in my mailbox:  
`~/Projects/AOF/mailbox/swe-architect/inbox/re-aof-09x-question.md`

---

**START HERE:**
1. Read design doc: `~/Projects/AOF/docs/design/SLA-PRIMITIVE-DESIGN.md`
2. Claim task: `bd update AOF-09x --claim --json`
3. Modify `src/types/task.ts` (add `sla` field)
4. Create `src/config/sla-defaults.ts` (default values)
5. Modify `src/validation/task-schema.ts` (add validation)
6. Update `org-chart.yaml` (add SLA section)
7. Write unit tests (schema, validation, resolution)
8. Close task: `bd close AOF-09x --json`

**Estimated Time:** 1 day  
**TDD:** Write tests before implementation
