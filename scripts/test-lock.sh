#!/usr/bin/env bash
# test-lock.sh — Serialize vitest runs via flock.
#
# Kernel-level advisory lock: auto-releases on process exit/crash/kill.
# No stale locks, no cleanup needed, no race conditions.
#
# Transitional until AOF-adf (dispatch throttling) ships at the scheduler
# level. Once concurrent agents use git worktrees, each gets its own lock
# via AOF_TEST_LOCK_DIR.
#
# Config:
#   AOF_TEST_LOCK_DIR     — lock directory (default: /tmp)
#   AOF_TEST_LOCK_TIMEOUT — max wait seconds (default: 300; 0 = fail immediately)
#
# Usage:
#   ./scripts/test-lock.sh [vitest args...]
#   npm test

set -euo pipefail

LOCK_FILE="${AOF_TEST_LOCK_DIR:-/tmp}/aof-vitest.lock"
TIMEOUT="${AOF_TEST_LOCK_TIMEOUT:-300}"

exec flock --timeout "$TIMEOUT" "$LOCK_FILE" npx vitest "$@"
