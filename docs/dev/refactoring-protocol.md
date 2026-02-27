# Refactoring Protocol — Incremental Extraction

This protocol is MANDATORY for all structural refactoring tasks (file splits, module extractions, symbol moves).

## Core Principle

**Move one function at a time. Test after every move. Never batch.**

A refactoring task that breaks tests is worse than no refactoring at all. The goal is zero behavior change — the tests prove it.

## Before Starting

### 1. Impact Analysis (Serena LSP — MANDATORY)

Before moving ANY code, understand the full dependency graph:

```
# For each function/symbol you plan to move:
find_references("<symbol_name>")
# → Lists every file + line that imports/calls it

get_symbols_overview("<source_file>")
# → Shows all exports, their types, line ranges

find_symbol("<symbol_name>")
# → Confirms canonical definition location
```

**Document the move plan** before editing:
- Symbol to move
- Source file → target file
- All files that reference it (from find_references)
- Expected import changes

### 2. Baseline Snapshot

```bash
# Record starting state
wc -l <source_file>
npm test 2>&1 | tail -3  # Record test count + pass/fail
git stash  # Clean working tree
```

## Extraction Loop (repeat for EACH function/symbol)

### Step 1: Move ONE symbol

- Cut the function/type/interface from the source file
- Paste into the target module
- Add the export

### Step 2: Update imports

- Use `find_references` output from the impact analysis
- Update EVERY file that imported the symbol from the old location
- Add re-export from old location if needed for backward compatibility

### Step 3: Test

```bash
npm test
```

- **GREEN?** → Continue to next symbol
- **RED?** → Fix immediately. Do NOT move the next symbol until green.

### Step 4: Commit

```bash
git add -A
git commit -m "refactor: extract <symbol> to <target>"
```

**One commit per extraction step.** Not one commit per file — one commit per logical move that keeps tests green.

## After Each File Split

```bash
# Verify sizes
wc -l <source_file> <new_module>

# Verify no regressions
npm test

# Push
git push origin main
```

## Anti-Patterns (DO NOT)

| Anti-Pattern | Why It Breaks |
|-------------|---------------|
| Move 5 functions at once | Import errors compound, impossible to debug |
| Create new module, then bulk-move | Intermediate state has broken imports |
| Skip `find_references` | Miss a caller → runtime crash |
| "I'll fix the tests after moving everything" | You won't. And the test count makes it impossible to tell what broke |
| Copy instead of move | Now you have two implementations. One will drift. |
| Change function signatures during refactor | Behavior change ≠ refactor. Separate concern. |

## Serena LSP Tools — Quick Reference for Refactoring

| Task | Tool | Why |
|------|------|-----|
| "What calls this function?" | `find_references` | Know all callers before moving |
| "What's in this file?" | `get_symbols_overview` | Plan extraction without reading 1600 lines |
| "Where is this defined?" | `find_symbol` | Confirm you're moving the right thing |
| "Rename across codebase" | `rename_symbol` | Safe rename of moved symbol |
| "Replace function body" | `edit_symbol` | Surgical edit without string-match fragility |
| "Find string/comment" | `search_pattern` | Catch hardcoded paths, string references |

## Size Verification (MANDATORY at end)

```bash
# All changed files must be <500 LOC
git diff --name-only HEAD~N | xargs wc -l | sort -rn | head -10

# Source file should have decreased significantly
# Target modules should each be <300 LOC
```
