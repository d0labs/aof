# Design: Adaptive Concurrency (Platform Limit Detection)

**Status**: Draft  
**Date**: 2026-02-16  
**Related**: AOF scheduler concurrency management

## Problem

AOF's scheduler has a static `maxConcurrentDispatches` (default 3), but OpenClaw enforces a per-agent `maxChildrenPerAgent` limit. When AOF's limit exceeds OpenClaw's platform limit, dispatches fail with:
```
sessions_spawn has reached max active children for this session (X/Y)
```

This causes:
- Tasks get blocked with `spawn_failed` errors
- Retry counters increment unnecessarily (it's a "wait for capacity" situation, not a real failure)
- No feedback loop to auto-adjust the scheduler's effective cap

## Solution: Adaptive Concurrency Cap

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Scheduler (scheduler.ts)                                     │
│                                                               │
│  maxConcurrentDispatches: 3 (config)                        │
│  effectiveConcurrencyLimit: null | number (runtime detected) │
│                                                               │
│  Effective cap = min(platformLimit, maxConcurrentDispatches) │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    │ spawn() → ExecutorResult
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenClawExecutor (openclaw-executor.ts)                      │
│                                                               │
│  Parse error message:                                        │
│    "max active children for this session (X/Y)"             │
│                                                               │
│  Extract Y (platform limit)                                  │
│                                                               │
│  Return: ExecutorResult {                                    │
│    success: false,                                           │
│    error: string,                                            │
│    platformLimit?: number  // NEW                            │
│  }                                                            │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Executor detects platform limit error**
   - Parse error string
   - Extract Y from "(X/Y)" pattern
   - Return `{ success: false, error: "...", platformLimit: Y }`

2. **Scheduler receives platform limit**
   - Set `effectiveConcurrencyLimit = min(Y, config.maxConcurrentDispatches ?? 3)`
   - Log adjustment: `[AOF] Platform concurrency limit detected: ${Y}, effective cap now ${cap}`
   - Emit `concurrency.platformLimit` event

3. **Action planning uses effective cap**
   - Replace `config.maxConcurrentDispatches ?? 3` with `effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3`
   - Prevents over-dispatching

4. **Requeue (not block) on platform limit**
   - Task stays in `ready` (not moved to `blocked`)
   - No retry count increment
   - Picked up automatically next poll when slot opens

---

## Implementation Plan

### 1. Extend ExecutorResult Interface

**File**: `src/dispatch/executor.ts`

```typescript
export interface ExecutorResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  platformLimit?: number;  // NEW: OpenClaw platform concurrency limit
}
```

### 2. Parse Platform Limit Error in Executor

**File**: `src/openclaw/openclaw-executor.ts`

Add helper method:
```typescript
private parsePlatformLimitError(error: string): number | undefined {
  // Match: "sessions_spawn has reached max active children for this session (X/Y)"
  const match = error.match(/max active children for this session \((\d+)\/(\d+)\)/);
  if (match) {
    return parseInt(match[2], 10); // Y = platform limit
  }
  return undefined;
}
```

Update `httpDispatch()` catch block:
```typescript
catch (err) {
  const error = err as Error;
  const platformLimit = this.parsePlatformLimitError(error.message);
  throw { message: error.message, platformLimit };
}
```

Update `spawn()` to propagate platform limit:
```typescript
async spawn(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
  try {
    // ... existing spawn logic ...
  } catch (err: any) {
    return {
      success: false,
      error: err.message || String(err),
      platformLimit: err.platformLimit, // NEW
    };
  }
}
```

### 3. Add Event Type

**File**: `src/schemas/event.ts`

Add to `EventType` enum:
```typescript
// Concurrency
"concurrency.platformLimit",
```

### 4. Track Effective Concurrency in Scheduler

**File**: `src/dispatch/scheduler.ts`

Add class field (if using a class) or module-level state:
```typescript
let effectiveConcurrencyLimit: number | null = null;
```

### 5. Update Spawn Failure Handling

In the `case "assign":` block, after `result.success === false`:

```typescript
if (!result.success) {
  // Check if this is a platform concurrency limit error
  if (result.platformLimit !== undefined) {
    const previousCap = effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3;
    effectiveConcurrencyLimit = Math.min(result.platformLimit, config.maxConcurrentDispatches ?? 3);
    
    console.info(
      `[AOF] Platform concurrency limit detected: ${result.platformLimit}, ` +
      `effective cap now ${effectiveConcurrencyLimit} (was ${previousCap})`
    );
    
    // Emit event
    await logger.log("concurrency.platformLimit", "scheduler", {
      taskId: action.taskId,
      payload: {
        detectedLimit: result.platformLimit,
        effectiveCap: effectiveConcurrencyLimit,
        previousCap,
      },
    });
    
    // Release lease (task will stay in ready, not blocked)
    await expireLeases(store, [action.taskId]);
    
    // No retry count increment - this is capacity exhaustion, not failure
    console.info(
      `[AOF] Task ${action.taskId} requeued to ready (platform capacity exhausted, ` +
      `will retry next poll)`
    );
    
    continue; // Skip block transition
  }
  
  // Normal spawn failure handling (existing code)
  console.error(`[AOF] [BUG-003] Executor spawn failed for task ${action.taskId}:`);
  // ... rest of existing error handling ...
}
```

### 6. Use Effective Cap in Action Planning

Around line 380, update:
```typescript
// OLD:
const maxDispatches = config.maxConcurrentDispatches ?? 3;

// NEW:
const maxDispatches = effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3;
```

---

## Test Plan

### Unit Tests

#### 1. Executor: Parse Platform Limit Error
**File**: `src/openclaw/__tests__/openclaw-executor-platform-limit.test.ts`

```typescript
describe("OpenClawExecutor - Platform Limit Detection", () => {
  it("should parse platform limit from error message", () => {
    const error = "sessions_spawn has reached max active children for this session (3/2)";
    // Mock internal parsePlatformLimitError or test through spawn()
    // Expect: platformLimit = 2
  });
  
  it("should return undefined for non-platform-limit errors", () => {
    const error = "Agent not found";
    // Expect: platformLimit = undefined
  });
  
  it("should handle different number formats", () => {
    const error = "max active children for this session (10/5)";
    // Expect: platformLimit = 5
  });
});
```

#### 2. Scheduler: Auto-Adjust Effective Cap
**File**: `src/dispatch/__tests__/scheduler-adaptive-concurrency.test.ts`

```typescript
describe("Scheduler - Adaptive Concurrency", () => {
  it("should detect platform limit and adjust effective cap", async () => {
    // Mock executor that returns platformLimit: 2
    // Config: maxConcurrentDispatches: 3
    // Expect: effectiveConcurrencyLimit = min(2, 3) = 2
    // Expect: event "concurrency.platformLimit" emitted
  });
  
  it("should use effective cap for action planning", async () => {
    // Set effectiveConcurrencyLimit = 1
    // Have 1 in-progress task
    // Have 2 ready tasks
    // Expect: only 0 new dispatches (1 in-progress >= 1 effective cap)
  });
  
  it("should requeue task to ready (not blocked) on platform limit", async () => {
    // Mock executor that returns platformLimit error
    // Expect: task stays in ready, no retry count increment
  });
  
  it("should not increment retry count for platform limit errors", async () => {
    // Mock executor that returns platformLimit error
    // Expect: task.metadata.retryCount unchanged
  });
  
  it("should use min(platform, config) for effective cap", async () => {
    // platformLimit: 5, config: 3
    // Expect: effectiveConcurrencyLimit = 3
    
    // platformLimit: 2, config: 5
    // Expect: effectiveConcurrencyLimit = 2
  });
});
```

### Integration Tests

#### 3. End-to-End Platform Limit Detection
**File**: `src/dispatch/__tests__/e2e-platform-limit.test.ts`

```typescript
describe("E2E: Platform Limit Detection", () => {
  it("should detect platform limit and requeue tasks", async () => {
    // Create 5 ready tasks
    // Mock executor that fails with platformLimit: 2 on 3rd spawn
    // Expect: 2 tasks dispatched, 3rd requeued to ready
    // Expect: next poll respects cap of 2
  });
  
  it("should eventually dispatch all tasks as slots open", async () => {
    // Create 5 ready tasks
    // Mock executor with platformLimit: 2
    // Simulate 2 tasks completing → 2 new dispatches
    // Expect: all 5 eventually dispatched
  });
});
```

---

## Constraints

- **Don't break existing 1349 tests**
- **Keep it minimal** — error detection + feedback loop only
- **No new queue abstractions** — use existing ready/in-progress states
- **No retry logic changes** — platform limit is special-cased (no retry count increment)

---

## Rollout

1. Add `platformLimit?` field to `ExecutorResult`
2. Implement platform limit parsing in executor
3. Add event type to schema
4. Update scheduler to track effective cap + handle platform limit errors
5. Update action planning to use effective cap
6. Add tests (executor, scheduler, e2e)
7. Run `npx vitest run --reporter=dot` to verify no regressions

---

## Metrics

After deployment, track:
- `concurrency.platformLimit` event frequency
- Effective cap adjustments (log analysis)
- Reduction in blocked tasks due to spawn failures
- Task throughput (tasks/minute) — should increase as scheduler avoids over-dispatching

---

## Future Enhancements

- **Backoff on platform limit**: If platform limit hit repeatedly, add exponential backoff before next poll
- **Per-agent limits**: Track effective cap per agent type (if different agents have different limits)
- **UI visibility**: Show effective cap vs. configured cap in scheduler dashboard
