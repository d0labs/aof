# Engineering Standards — Implementation Agents

These standards apply to all agents that write code (backend, frontend, SRE, cybersecurity).
Read this before every implementation task.

## SOLID Principles

### Single Responsibility (SRP)
- One module = one reason to change. If you can describe a module's purpose with "and", split it.
- One function = one job. If it fetches AND transforms AND persists, break it into three.

### Open/Closed (OCP)
- Extend behavior through composition, not modification of existing code.
- New features should add files/functions, not grow existing ones.
- Use registries, plugin patterns, and dispatch tables to make systems extensible without editing core logic.

### Liskov Substitution (LSP)
- Any implementation of an interface must be a drop-in replacement.
- Don't add preconditions that narrow the contract. Don't weaken postconditions.

### Interface Segregation (ISP)
- Prefer small, focused interfaces over large ones. A consumer should never depend on methods it doesn't use.
- If an interface has >5 methods, consider splitting by usage pattern.

### Dependency Inversion (DIP)
- Depend on abstractions (interfaces/types), not concrete implementations.
- Constructor/function parameters should accept interfaces. Let the caller decide the implementation.
- This is how we got `ITaskStore` — the store abstraction that lets us swap filesystem for DB later.

## Data-Driven / Dispatch Table Design

When you see:
- >3 similar `if/else` or `switch` cases
- The same function called repeatedly with different constants
- Branching that selects behavior by key (string, enum, event type)

**Use a dispatch table / registry:**

```typescript
// ❌ Bad: scattered branching
if (action === "create") { handleCreate(task); }
else if (action === "cancel") { handleCancel(task); }
else if (action === "block") { handleBlock(task); }
else if (action === "close") { handleClose(task); }

// ✅ Good: data-driven dispatch
const handlers: Record<string, (t: Task) => Promise<void>> = {
  create: handleCreate,
  cancel: handleCancel,
  block: handleBlock,
  close: handleClose,
};
const handler = handlers[action];
if (!handler) throw new Error(`Unknown action: ${action}`);
await handler(task);
```

**Benefits:**
- Adding a new action = adding one table entry, not another branch
- Type-safe keys catch typos at compile time
- Validation is automatic (unknown key = loud failure)
- Easy to test exhaustively (iterate the table)

**When NOT to use:** ≤3 cases, or each case has substantially different logic/signatures.

## Performance Awareness

### Hot Path Rules
- **Know your complexity.** O(n²) in a loop that runs every poll cycle will kill you at scale.
- **Prefer Maps over repeated array scans.** `array.find()` in a loop = O(n²). Build a Map first = O(n).
- **Stream, don't buffer.** Don't load entire files/datasets into memory when you can process line-by-line.
- **Lazy initialization.** Don't compute/load things until they're needed. Especially in startup paths.
- **Avoid unnecessary allocations in tight loops.** Pre-allocate buffers, reuse objects where safe.

### I/O Rules
- **Batch I/O operations.** 10 sequential file reads = 10 syscalls. One `readdir` + selective reads = faster.
- **Use `Promise.all` for independent async operations.** Don't `await` sequentially when operations are independent.
- **Cache expensive computations** with clear invalidation strategy (TTL or event-driven).

### When Performance Doesn't Matter
- One-time setup code, CLI commands, test fixtures — optimize for readability, not speed.
- Don't prematurely optimize. But DO think about complexity class when writing loops.

## Error Handling

### Philosophy: Fail Fast, Fail Loud
- **Invalid state → throw immediately.** Don't silently continue with bad data.
- **Use typed errors** when callers need to distinguish error kinds:
  ```typescript
  class TaskNotFoundError extends Error { constructor(id: string) { super(`Task not found: ${id}`); this.name = "TaskNotFoundError"; } }
  ```
- **Never swallow errors silently.** `catch (e) {}` is forbidden. At minimum, log.
- **Validate at trust boundaries.** Parse external input (user, file, API) with schema validation (Zod). Internal function calls between trusted modules don't need re-validation.

### Error Propagation
- Let errors bubble unless you can meaningfully handle them.
- Catch at the boundary where you can take a useful action (retry, fallback, user-facing message).
- Log with context: what was attempted, what failed, what the inputs were.

## DRY — Don't Repeat Yourself

- **Two instances of similar code = warning.** Three = mandatory extraction.
- Extract shared logic into utility functions, not copy-paste.
- Shared types/interfaces go in a `types.ts` or the relevant schema file.
- If two modules share a helper, move it to a common location — don't duplicate.

## Abstraction at Module Scope

- **Each module has a public API (exports) and private internals.**
- Exports should be stable interfaces that callers depend on. Internals can change freely.
- Use barrel files (`index.ts`) sparingly — only for package-level public API, not within a module.
- Name files for what they DO, not what they ARE: `throttle.ts` not `ThrottleManager.ts`.

## Dependency Policy

- **Do not install or add new dependencies.** If a library would help, mention it in your completion report with the package name and why. The architect decides.
- **Do use existing project dependencies** fully. Check `package.json` before reimplementing something that's already available.
- **Prefer Node.js built-ins** (`node:fs`, `node:path`, `node:crypto`) over external packages for basic operations.
