# Implementation Brief: Adaptive Concurrency (Platform Limit Detection)

**Architect**: swe-architect  
**Date**: 2026-02-16  
**Design Doc**: `~/Projects/AOF/docs/design/adaptive-concurrency.md`

---

## Context

AOF's scheduler has a static `maxConcurrentDispatches` (default 3), but OpenClaw enforces a runtime `maxChildrenPerAgent` limit. When AOF tries to exceed OpenClaw's limit, spawns fail with:
```
sessions_spawn has reached max active children for this session (X/Y)
```

Currently these failures:
- Move tasks to `blocked` state
- Increment retry counters unnecessarily
- Provide no feedback to the scheduler

**Goal**: Detect platform limit errors, feed them back to the scheduler, auto-adjust the effective concurrency cap, and requeue tasks (not block them) when hitting platform limits.

---

## Objective

Implement adaptive concurrency detection:
1. Executor parses platform limit from error messages
2. Scheduler tracks effective concurrency cap (min of platform limit and config)
3. Tasks hitting platform limits are requeued to `ready` (not blocked, no retry increment)
4. Scheduler uses effective cap for action planning
5. Emit `concurrency.platformLimit` events when limit is detected

---

## Scope

### Files to Modify

1. **`src/dispatch/executor.ts`**
   - Add `platformLimit?: number` field to `ExecutorResult` interface

2. **`src/openclaw/openclaw-executor.ts`**
   - Add `parsePlatformLimitError(error: string): number | undefined` private method
   - Update `httpDispatch()` catch block to extract platform limit
   - Update `spawnAgentFallback()` catch block to extract platform limit
   - Propagate `platformLimit` in `ExecutorResult`

3. **`src/schemas/event.ts`**
   - Add `"concurrency.platformLimit"` to `EventType` enum

4. **`src/dispatch/scheduler.ts`**
   - Add module-level state: `let effectiveConcurrencyLimit: number | null = null`
   - Update action planning (line ~380): use `effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3`
   - Update spawn failure handling (line ~850+):
     - Check if `result.platformLimit !== undefined`
     - Set `effectiveConcurrencyLimit = min(platformLimit, config.maxConcurrentDispatches ?? 3)`
     - Log adjustment
     - Emit `concurrency.platformLimit` event
     - Release lease (task stays in `ready`)
     - Skip normal block transition

### Files to Create (Tests)

5. **`src/openclaw/__tests__/openclaw-executor-platform-limit.test.ts`**
   - Test platform limit parsing
   - Test non-platform-limit errors (should return undefined)
   - Test various number formats

6. **`src/dispatch/__tests__/scheduler-adaptive-concurrency.test.ts`**
   - Test effective cap auto-adjustment
   - Test action planning respects effective cap
   - Test requeue to ready (not blocked) on platform limit
   - Test no retry count increment for platform limit errors
   - Test min(platform, config) logic

7. **`src/dispatch/__tests__/e2e-platform-limit.test.ts`**
   - End-to-end test: detect platform limit, requeue tasks, respect cap on next poll
   - Test tasks eventually dispatch as slots open

---

## Acceptance Criteria

### Functional
- [ ] Executor correctly parses "max active children for this session (X/Y)" → platformLimit: Y
- [ ] Executor returns `platformLimit` in `ExecutorResult` when detected
- [ ] Non-platform-limit errors do not set `platformLimit` (undefined)
- [ ] Scheduler sets `effectiveConcurrencyLimit` when platform limit detected
- [ ] Scheduler uses `effectiveConcurrencyLimit` for action planning (concurrency cap)
- [ ] Tasks hitting platform limit are requeued to `ready` (not moved to `blocked`)
- [ ] Tasks hitting platform limit do NOT increment `retryCount`
- [ ] Event `concurrency.platformLimit` is emitted with payload: `{ detectedLimit, effectiveCap, previousCap }`
- [ ] Scheduler logs: `[AOF] Platform concurrency limit detected: ${limit}, effective cap now ${cap}`

### Testing
- [ ] All new tests pass
- [ ] Existing 1349 tests still pass (`npx vitest run --reporter=dot`)
- [ ] No test regressions

### Code Quality
- [ ] Functions <60 LOC (aim), <120 LOC (max)
- [ ] No duplicate logic (DRY)
- [ ] Clear error messages with context

---

## Implementation Details

### 1. Executor Platform Limit Parsing

**File**: `src/openclaw/openclaw-executor.ts`

Add private method:
```typescript
/**
 * Parse platform concurrency limit from OpenClaw error message.
 * 
 * Example error:
 *   "sessions_spawn has reached max active children for this session (3/2)"
 * 
 * Returns: 2 (the platform limit Y from pattern X/Y)
 */
private parsePlatformLimitError(error: string): number | undefined {
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
  
  // Throw object with both message and platformLimit
  const enhancedError: any = new Error(error.message);
  enhancedError.platformLimit = platformLimit;
  throw enhancedError;
}
```

Update `spawn()` to propagate platform limit:
```typescript
async spawn(context: TaskContext, opts?: { timeoutMs?: number }): Promise<ExecutorResult> {
  // ... existing logic ...
  
  // In catch blocks for both httpDispatch and spawnAgentFallback:
  } catch (err: any) {
    return {
      success: false,
      error: err.message || String(err),
      platformLimit: err.platformLimit, // Propagate platform limit
    };
  }
}
```

### 2. Executor Interface Extension

**File**: `src/dispatch/executor.ts`

```typescript
export interface ExecutorResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  platformLimit?: number;  // NEW: OpenClaw platform concurrency limit
}
```

### 3. Event Schema Update

**File**: `src/schemas/event.ts`

Add to `EventType` enum (after other concurrency/dispatch events):
```typescript
// Concurrency
"concurrency.platformLimit",
```

### 4. Scheduler Effective Cap Tracking

**File**: `src/dispatch/scheduler.ts`

Add at module level (top of file, after imports):
```typescript
/**
 * Effective concurrency limit — auto-detected from OpenClaw platform limit.
 * Starts null, set to min(platformLimit, config.maxConcurrentDispatches) when detected.
 */
let effectiveConcurrencyLimit: number | null = null;
```

### 5. Scheduler Action Planning Update

In `poll()` function, around line 380:
```typescript
// OLD:
// const maxDispatches = config.maxConcurrentDispatches ?? 3;

// NEW:
const maxDispatches = effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3;

// Log concurrency status (update existing log)
console.info(
  `[AOF] Concurrency limit: ${currentInProgress}/${maxDispatches} in-progress` +
  (effectiveConcurrencyLimit !== null ? ` (platform-adjusted from ${config.maxConcurrentDispatches ?? 3})` : "")
);
```

### 6. Scheduler Spawn Failure Handling

In the `case "assign":` block, after `if (!result.success)`, **before** existing error handling:

```typescript
if (!result.success) {
  // NEW: Check if this is a platform concurrency limit error
  if (result.platformLimit !== undefined) {
    const previousCap = effectiveConcurrencyLimit ?? config.maxConcurrentDispatches ?? 3;
    effectiveConcurrencyLimit = Math.min(result.platformLimit, config.maxConcurrentDispatches ?? 3);
    
    console.info(
      `[AOF] Platform concurrency limit detected: ${result.platformLimit}, ` +
      `effective cap now ${effectiveConcurrencyLimit} (was ${previousCap})`
    );
    
    // Emit event (non-fatal if logging fails)
    try {
      await logger.log("concurrency.platformLimit", "scheduler", {
        taskId: action.taskId,
        payload: {
          detectedLimit: result.platformLimit,
          effectiveCap: effectiveConcurrencyLimit,
          previousCap,
        },
      });
    } catch (logErr) {
      console.error(`[AOF] Failed to log concurrency.platformLimit event: ${(logErr as Error).message}`);
    }
    
    // Release lease — task stays in ready (not blocked)
    // Use expireLeases to clear the lease cleanly
    try {
      await expireLeases(store, [action.taskId]);
    } catch (expireErr) {
      console.error(`[AOF] Failed to expire lease for ${action.taskId}: ${(expireErr as Error).message}`);
    }
    
    // No retry count increment - this is capacity exhaustion, not failure
    console.info(
      `[AOF] Task ${action.taskId} requeued to ready (platform capacity exhausted, ` +
      `will retry next poll)`
    );
    
    continue; // Skip normal block transition and move to next action
  }
  
  // EXISTING: Normal spawn failure handling (keep existing code)
  console.error(`[AOF] [BUG-003] Executor spawn failed for task ${action.taskId}:`);
  // ... rest of existing error handling ...
}
```

---

## Test Requirements

### Executor Tests (`src/openclaw/__tests__/openclaw-executor-platform-limit.test.ts`)

**Estimated**: 3 tests

```typescript
import { describe, it, expect, vi } from "vitest";
import { OpenClawExecutor } from "../openclaw-executor.js";
import type { OpenClawApi } from "../types.js";

describe("OpenClawExecutor - Platform Limit Detection", () => {
  it("should parse platform limit from error message", async () => {
    // Mock API and config
    const mockApi: OpenClawApi = {
      config: { gateway: { port: 3000, auth: { token: "test" } } },
    };
    
    // Mock fetch to return platform limit error
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({
        error: "sessions_spawn has reached max active children for this session (3/2)"
      }),
    });
    
    const executor = new OpenClawExecutor(mockApi);
    const result = await executor.spawn({
      taskId: "test-001",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: { agent: "agent:test:main" },
      projectId: "test-project",
      projectRoot: "/path/to/project",
      taskRelpath: "tasks/test-001.md",
    });
    
    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(2);
    expect(result.error).toContain("max active children");
  });
  
  it("should return undefined platformLimit for non-platform-limit errors", async () => {
    const mockApi: OpenClawApi = {
      config: { gateway: { port: 3000, auth: { token: "test" } } },
    };
    
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "Agent not found" }),
    });
    
    const executor = new OpenClawExecutor(mockApi);
    const result = await executor.spawn({
      taskId: "test-002",
      taskPath: "/path/to/task.md",
      agent: "agent:nonexistent:main",
      priority: "medium",
      routing: { agent: "agent:nonexistent:main" },
      projectId: "test-project",
      projectRoot: "/path/to/project",
      taskRelpath: "tasks/test-002.md",
    });
    
    expect(result.success).toBe(false);
    expect(result.platformLimit).toBeUndefined();
    expect(result.error).toContain("Agent not found");
  });
  
  it("should handle different number formats in platform limit", async () => {
    const mockApi: OpenClawApi = {
      config: { gateway: { port: 3000, auth: { token: "test" } } },
    };
    
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({
        error: "max active children for this session (10/5)"
      }),
    });
    
    const executor = new OpenClawExecutor(mockApi);
    const result = await executor.spawn({
      taskId: "test-003",
      taskPath: "/path/to/task.md",
      agent: "agent:test:main",
      priority: "medium",
      routing: { agent: "agent:test:main" },
      projectId: "test-project",
      projectRoot: "/path/to/project",
      taskRelpath: "tasks/test-003.md",
    });
    
    expect(result.success).toBe(false);
    expect(result.platformLimit).toBe(5);
  });
});
```

### Scheduler Tests (`src/dispatch/__tests__/scheduler-adaptive-concurrency.test.ts`)

**Estimated**: 5 tests

Key test scenarios:
1. Detect platform limit and adjust effective cap
2. Use effective cap for action planning (respect cap)
3. Requeue task to ready (not blocked) on platform limit
4. No retry count increment for platform limit errors
5. Test min(platform, config) logic

### E2E Tests (`src/dispatch/__tests__/e2e-platform-limit.test.ts`)

**Estimated**: 2 tests

1. Detect platform limit, requeue tasks, respect cap on next poll
2. Tasks eventually dispatch as slots open

---

## Out of Scope

- Backoff strategies (future enhancement)
- Per-agent limit tracking (future enhancement)
- UI visualization (future enhancement)
- Dynamic adjustment of config.maxConcurrentDispatches (only effective limit changes)

---

## Dependencies

- Existing scheduler infrastructure (`scheduler.ts`, `task-store.ts`, `event-logger.ts`)
- Existing executor interface (`executor.ts`, `openclaw-executor.ts`)
- Event schema (`schemas/event.ts`)

---

## Estimated Effort

- **Executor changes**: 30 minutes (parsing + propagation)
- **Scheduler changes**: 1 hour (tracking + feedback loop)
- **Event schema**: 5 minutes
- **Tests**: 2 hours (executor + scheduler + e2e)
- **Total**: ~4 hours

---

## Validation

Run full test suite:
```bash
cd ~/Projects/AOF
npx vitest run --reporter=dot
```

Expected:
- All new tests pass
- All existing 1349 tests pass
- No regressions

---

## Notes

- **Platform limit detection is best-effort** — if error message format changes, parsing will return undefined
- **Effective cap persists across polls** — once detected, it stays until process restart
- **Tasks requeued to ready** (not blocked) — this is capacity exhaustion, not failure
- **No retry count increment** — platform limit is not counted as a task failure

---

## Questions for Architect

None — design is complete and prescriptive.
