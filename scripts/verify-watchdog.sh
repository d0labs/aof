#!/usr/bin/env bash
# verify-watchdog.sh -- End-to-end verification that the OS supervisor
# restarts the AOF daemon after a crash (DAEM-05).
#
# Prerequisites:
#   - AOF built (npm run build)
#   - Running on macOS (launchd) or Linux (systemd)
#
# This script:
#   1. Installs the daemon via `aof daemon install`
#   2. Verifies it is running via `aof daemon status`
#   3. Sends SIGKILL to simulate a crash
#   4. Waits up to 30 seconds for the OS supervisor to restart
#   5. Verifies the daemon is running again (new PID)
#   6. Cleans up via `aof daemon uninstall`
#
# Exit codes: 0 = watchdog works, 1 = watchdog failed

set -euo pipefail

AOF=${AOF_BIN:-"npx aof"}
TIMEOUT=30
POLL_INTERVAL=2

echo "=== DAEM-05 Watchdog Verification ==="
echo ""

# Step 1: Install
echo "[1/6] Installing daemon..."
$AOF daemon install
sleep 2

# Step 2: Verify running
echo "[2/6] Checking daemon is running..."
$AOF daemon status --json > /tmp/aof-watchdog-pre.json 2>/dev/null
PRE_STATUS=$(cat /tmp/aof-watchdog-pre.json)
echo "  Pre-crash status: $(echo "$PRE_STATUS" | head -1)"

# Get PID
PID_FILE="${AOF_ROOT:-$HOME/.aof}/daemon.pid"
if [ ! -f "$PID_FILE" ]; then
  echo "FAIL: No PID file found at $PID_FILE"
  $AOF daemon uninstall 2>/dev/null || true
  exit 1
fi

OLD_PID=$(cat "$PID_FILE")
echo "  Current PID: $OLD_PID"

# Step 3: SIGKILL
echo "[3/6] Sending SIGKILL to PID $OLD_PID (simulating crash)..."
kill -9 "$OLD_PID" 2>/dev/null || true
sleep 1

# Step 4: Wait for restart
echo "[4/6] Waiting up to ${TIMEOUT}s for OS supervisor to restart daemon..."
ELAPSED=0
RESTARTED=false

while [ $ELAPSED -lt $TIMEOUT ]; do
  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))

  if [ -f "$PID_FILE" ]; then
    NEW_PID=$(cat "$PID_FILE")
    if [ "$NEW_PID" != "$OLD_PID" ] && kill -0 "$NEW_PID" 2>/dev/null; then
      RESTARTED=true
      echo "  Daemon restarted after ${ELAPSED}s (new PID: $NEW_PID)"
      break
    fi
  fi

  echo "  Waiting... ${ELAPSED}s / ${TIMEOUT}s"
done

# Step 5: Verify
echo "[5/6] Verifying daemon health..."
if [ "$RESTARTED" = true ]; then
  sleep 2  # Give health server time to bind
  if $AOF daemon status --json > /tmp/aof-watchdog-post.json 2>/dev/null; then
    echo "  Post-restart status: OK"
  else
    echo "  WARNING: Status check returned non-zero but daemon is running"
  fi
else
  echo "FAIL: Daemon was not restarted within ${TIMEOUT}s"
  $AOF daemon uninstall 2>/dev/null || true
  exit 1
fi

# Step 6: Cleanup
echo "[6/6] Cleaning up..."
$AOF daemon uninstall 2>/dev/null || true

echo ""
echo "=== PASS: Watchdog restart verified (DAEM-05) ==="
echo "  Old PID: $OLD_PID"
echo "  New PID: $NEW_PID"
echo "  Restart time: ${ELAPSED}s"
exit 0
