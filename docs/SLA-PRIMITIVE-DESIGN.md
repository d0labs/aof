# SLA Primitive Design
**Phase:** 1.5 Recovery Hardening  
**Tasks:** AOF-tzd (schema), AOF-efr (scheduler integration)  
**Author:** swe-architect  
**Date:** 2026-02-13

## Overview

Add Service Level Agreement (SLA) primitives to AOF task schema and scheduler. Detect tasks that exceed expected in-progress duration and take action based on violation policy.

## Design Principles

1. **Advisory first, blocking later** - Phase 1 alerts only, Phase 2 can block/deadletter
2. **Per-task overrides** - Projects set defaults, tasks can override
3. **Observable** - All violations logged to events.jsonl
4. **Generous defaults** - 1hr normal, 4hr research (avoid alert fatigue)

## Schema Design

### Task Frontmatter Extensions

**Location:** `src/schemas/task-schema.ts`

```typescript
export interface TaskSLA {
  maxInProgressMs?: number; // per-task override (optional)
  onViolation?: 'alert' | 'block' | 'deadletter'; // default: alert
}

export interface TaskFrontmatter {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  // ... existing fields ...
  sla?: TaskSLA; // optional per-task SLA override
}
```

**Example task frontmatter:**

```yaml
---
id: AOF-123
title: Deep research spike
status: in-progress
priority: high
routing:
  agent: swe-researcher
sla:
  maxInProgressMs: 14400000  # 4 hours
  onViolation: alert
---
```

### Project Config Extensions

**Location:** `src/config/org-chart-schema.ts`

```typescript
export interface ProjectSLAConfig {
  defaultMaxInProgressMs: number; // default: 3600000 (1 hour)
  researchMaxInProgressMs: number; // default: 14400000 (4 hours)
  onViolation: 'alert' | 'block' | 'deadletter'; // default: alert
}

export interface ProjectConfig {
  name: string;
  root: string;
  // ... existing fields ...
  sla?: ProjectSLAConfig; // optional project-level SLA defaults
}
```

**Example org-chart.yaml:**

```yaml
aof:
  projects:
    my-project:
      sla:
        defaultMaxInProgressMs: 3600000  # 1 hour
        researchMaxInProgressMs: 14400000  # 4 hours
        onViolation: alert  # Phase 1: advisory only
      ops:
        alertChannels:
          - type: slack
            webhook: https://hooks.slack.com/...
```

## SLA Resolution Algorithm

When evaluating a task's SLA, use this precedence:

1. **Per-task override:** If `task.frontmatter.sla.maxInProgressMs` is set, use it
2. **Project default:** Else use `project.sla.defaultMaxInProgressMs`
3. **Global fallback:** Else use 3600000 (1 hour)

```typescript
function getTaskSLALimit(task: Task, project: ProjectConfig): number {
  if (task.frontmatter.sla?.maxInProgressMs) {
    return task.frontmatter.sla.maxInProgressMs;
  }
  
  const projectSLA = project.sla?.defaultMaxInProgressMs;
  return projectSLA ?? 3600000; // 1 hour default
}
```

## Scheduler Integration

### Location: `src/dispatch/scheduler.ts`

**New function:**

```typescript
async function checkSLAViolations(
  tasks: Task[],
  project: ProjectConfig
): Promise<void> {
  const now = Date.now();
  
  for (const task of tasks) {
    if (task.status !== 'in-progress') continue;
    
    const slaLimit = getTaskSLALimit(task, project);
    const inProgressDuration = now - new Date(task.updatedAt).getTime();
    
    if (inProgressDuration > slaLimit) {
      await handleSLAViolation(task, {
        duration: inProgressDuration,
        limit: slaLimit,
        policy: task.frontmatter.sla?.onViolation ?? project.sla?.onViolation ?? 'alert'
      });
    }
  }
}
```

**Integration point:**

```typescript
// In scheduler poll loop
export async function schedulerPoll(context: AOFContext): Promise<void> {
  const tasks = await loadAllTasks(context);
  
  // Existing: dispatch ready tasks
  await dispatchReadyTasks(tasks, context);
  
  // NEW: check SLA violations
  await checkSLAViolations(tasks, context.project);
  
  // Existing: update state, log metrics
  await updateSchedulerState(context);
}
```

## Violation Handling

### Phase 1: Alert Only

```typescript
async function handleSLAViolation(
  task: Task,
  violation: SLAViolation
): Promise<void> {
  // Log to events.jsonl
  await logEvent({
    timestamp: new Date().toISOString(),
    type: 'sla.violation',
    taskId: task.id,
    title: task.title,
    agent: task.lease?.agent,
    duration: violation.duration,
    limit: violation.limit,
    exceededBy: violation.duration - violation.limit,
    policy: violation.policy
  });
  
  // Send alert to ops (if policy is 'alert')
  if (violation.policy === 'alert') {
    await alertOps({
      title: `SLA violation: ${task.id}`,
      message: `Task "${task.title}" has been in-progress for ${formatDuration(violation.duration)} (limit: ${formatDuration(violation.limit)})`,
      severity: 'warning',
      metadata: {
        taskId: task.id,
        agent: task.lease?.agent,
        duration: violation.duration,
        limit: violation.limit
      }
    });
  }
  
  // Phase 2: handle 'block' and 'deadletter' policies
  // (not implemented in Phase 1)
}
```

### Phase 2: Blocking Policies (Future)

```typescript
// Future enhancement
if (violation.policy === 'block') {
  await transitionTask(task, 'blocked', {
    reason: 'SLA violation',
    duration: violation.duration,
    limit: violation.limit
  });
}

if (violation.policy === 'deadletter') {
  await transitionTask(task, 'deadletter', {
    reason: 'SLA violation',
    duration: violation.duration,
    limit: violation.limit
  });
}
```

## Event Schema

**New event types for events.jsonl:**

```json
{
  "timestamp": "2026-02-13T16:00:00.000Z",
  "type": "sla.violation",
  "taskId": "AOF-123",
  "title": "Implement auth middleware",
  "agent": "swe-backend",
  "duration": 4500000,
  "limit": 3600000,
  "exceededBy": 900000,
  "policy": "alert"
}

{
  "timestamp": "2026-02-13T16:00:00.000Z",
  "type": "sla.alert_sent",
  "taskId": "AOF-123",
  "channel": "slack",
  "success": true
}
```

## Alert Format

**Slack/Discord message:**

```
⚠️ SLA Violation: AOF-123

**Task:** Implement auth middleware
**Agent:** swe-backend
**Duration:** 1h 15m (limit: 1h)
**Exceeded by:** 15m

View task: aof task show AOF-123
```

**Email subject:**

```
[AOF Alert] SLA violation: AOF-123 (Implement auth middleware)
```

## Rate Limiting

To avoid alert fatigue, rate-limit SLA alerts:

- **No more than 1 alert per task per 15 minutes**
- Track last alert time in scheduler state (in-memory)
- If alert was sent < 15min ago, skip (but still log to events.jsonl)

```typescript
const lastAlertMap = new Map<string, number>(); // taskId -> timestamp

async function shouldSendAlert(taskId: string): Promise<boolean> {
  const lastAlert = lastAlertMap.get(taskId);
  if (!lastAlert) return true;
  
  const timeSinceLastAlert = Date.now() - lastAlert;
  return timeSinceLastAlert > 900000; // 15 minutes
}

async function recordAlert(taskId: string): Promise<void> {
  lastAlertMap.set(taskId, Date.now());
}
```

## CLI Commands

**Check SLA status of a task:**

```bash
aof task sla AOF-123

# Output:
Task: AOF-123 (Implement auth middleware)
Status: in-progress
In-Progress Duration: 1h 15m
SLA Limit: 1h (from project defaults)
Status: ⚠️ VIOLATED (15m over limit)
Policy: alert
Last Alert: 2026-02-13T16:00:00Z
```

**List all SLA violations:**

```bash
aof task sla --violations

# Output:
2 tasks currently violating SLA:
- AOF-123: Implement auth middleware (1h 15m / 1h limit, +15m)
- AOF-456: Research spike (5h / 4h limit, +1h)
```

## Testing Strategy

### Unit Tests

- `src/schemas/__tests__/sla-schema.test.ts`
  - SLA schema validation
  - Per-task override parsing
  - Project default parsing

- `src/dispatch/__tests__/sla-resolution.test.ts`
  - SLA resolution algorithm (task > project > default)
  - Duration calculation (in-progress time)
  - Violation detection logic

- `src/dispatch/__tests__/sla-handling.test.ts`
  - Alert policy (log + send alert)
  - Rate limiting (max 1 alert per 15min)
  - Event logging

### Integration Tests

- `tests/e2e/sla-violations.test.ts`
  - Task exceeds SLA → alert sent
  - Task with per-task override → uses override limit
  - Task with no override → uses project default
  - Multiple violations → rate-limited alerts

## Migration / Rollout

**Phase 1.5:** SLA checks enabled, alert-only mode
- Add `sla` field to task schema (optional)
- Add `sla` config to project schema (optional)
- Scheduler checks SLA on every poll
- Violations trigger alerts only (no blocking)

**Phase 2:** Add blocking policies
- Support `onViolation: block` (transition to blocked status)
- Support `onViolation: deadletter` (transition to deadletter queue)
- CLI flag to enable blocking mode per project

## Default Values

**Rationale for 1hr / 4hr defaults:**

- **1 hour (normal tasks):** Covers most backend/frontend work
  - Bug fixes: 15-45 min
  - Small features: 30-60 min
  - Refactoring: 30-90 min
  
- **4 hours (research tasks):** Covers investigation/design
  - Architecture design: 2-4 hours
  - Spike/PoC: 2-6 hours
  - Learning new tech: 4-8 hours

**Future tuning:** After Phase 1.5 rollout, analyze actual task durations and adjust defaults based on data.

## Acceptance Criteria

- ✅ Task schema supports optional `sla` field
- ✅ Project config supports optional `sla` defaults
- ✅ Scheduler checks SLA violations every poll cycle
- ✅ SLA resolution uses task > project > default precedence
- ✅ Violations are logged to events.jsonl
- ✅ Violations trigger alerts to ops channels (Phase 1: alert-only)
- ✅ Alerts are rate-limited (max 1 per task per 15min)
- ✅ CLI command shows SLA status and violations
- ✅ Integration tests validate violation detection and alerts

## References

- PO Requirements: `~/.openclaw/agents/swe-po/workspace/memory/projects/aof/recovery-requirements.md`
- Tasks: `bd show AOF-tzd`, `bd show AOF-efr`
