#!/usr/bin/env bash
# ─── CocoMind Engine Launcher ──────────────────────────────────────────
# Wrapper script for running the Pipecat voice pipeline.
# Called by coco-agent.service and coco-agent-scheduler.
#
# - Activates the Python venv
# - Sources env vars from both coco-device and coco-engine
# - Acquires exclusive lock (one session at a time)
# - Runs voice_server.py
# - Records session outcome
# ────────────────────────────────────────────────────────────────────────

set -euo pipefail

COCO_DEVICE_DIR="${COCO_DEVICE_DIR:-/home/jerryhsieh2002/coco-device}"
COCO_ENGINE_DIR="${COCO_ENGINE_DIR:-/home/jerryhsieh2002/coco-engine}"
LOCK_FILE="/tmp/coco-session-runner.lock"
LOG_DIR="/var/log/coco"
LOG_FILE="${LOG_DIR}/agent.log"
LAST_SESSION_FILE="/var/lib/coco/last_session_at"

# Ensure log file is writable
if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then
    :
else
    LOG_FILE="${HOME}/.coco-agent.log"
fi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# ── Exclusive lock ──
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    log "Another session is already running — exiting"
    exit 0
fi

log "=== CocoMind Engine session starting ==="

# ── Load environment ──
# Source coco-device .env first (has backend URL, device ID, audio config)
if [ -f "${COCO_DEVICE_DIR}/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "${COCO_DEVICE_DIR}/.env"
    set +a
fi

# Source coco-engine .env (has API keys for Pipecat services)
if [ -f "${COCO_ENGINE_DIR}/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "${COCO_ENGINE_DIR}/.env"
    set +a
fi

# ── Activate Python venv ──
VENV_ACTIVATE="${COCO_ENGINE_DIR}/.venv/bin/activate"
if [ ! -f "$VENV_ACTIVATE" ]; then
    log "ERROR: Python venv not found at ${VENV_ACTIVATE}"
    exit 1
fi
# shellcheck disable=SC1090
source "$VENV_ACTIVATE"

# ── Run voice server ──
SESSION_START=$(date +%s)
EXIT_CODE=0

log "Starting Pipecat voice server..."
python "${COCO_ENGINE_DIR}/pipecat/voice_server.py" 2>&1 | tee -a "$LOG_FILE" || EXIT_CODE=$?

SESSION_END=$(date +%s)
DURATION=$((SESSION_END - SESSION_START))

log "Voice server exited with code ${EXIT_CODE} after ${DURATION}s"

# ── Record session outcome ──
if [ -d "$(dirname "$LAST_SESSION_FILE")" ]; then
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LAST_SESSION_FILE" 2>/dev/null || true
fi

# Map exit codes
if [ "$EXIT_CODE" -eq 0 ]; then
    if [ "$DURATION" -ge 10 ]; then
        log "Session result: success (${DURATION}s)"
    else
        log "Session result: too short (${DURATION}s) — possible crash"
        EXIT_CODE=1
    fi
elif [ "$EXIT_CODE" -eq 2 ]; then
    log "Session result: unattended"
elif [ "$EXIT_CODE" -eq 3 ]; then
    log "Session result: early exit"
else
    log "Session result: error (exit code ${EXIT_CODE})"
fi

log "=== CocoMind Engine session ended ==="
exit "$EXIT_CODE"
