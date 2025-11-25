#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="/var/log/coco/agent.log"
LOCK_FILE="${LOCK_FILE:-/tmp/coco-session-runner.lock}"
SCHED_LOG="/var/log/coco/session-scheduler.log"
RUN_USER="${COCO_RUN_USER:-${SUDO_USER:-${USER}}}"
REPO_DIR="${COCO_REPO_DIR:-/home/${RUN_USER}/coco-device}"
LAST_SESSION_FILE="${COCO_LAST_SESSION_FILE:-/var/lib/coco/last_session_at}"

mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
chmod 644 "$LOG_FILE" 2>/dev/null || true
exec >>"$LOG_FILE" 2>&1

if [[ "${SKIP_AGENT_LOCK:-0}" != "1" ]]; then
  exec {LOCK_FD}> "$LOCK_FILE"
  if ! flock -n "$LOCK_FD"; then
    msg="[agent] Another Coco session is already running; exiting."
    echo "$msg" >&2
    if [[ -w "$SCHED_LOG" || ( ! -e "$SCHED_LOG" && -w "$(dirname "$SCHED_LOG")" ) ]]; then
      echo "$msg" >> "$SCHED_LOG" 2>/dev/null || true
    fi
    exit 0
  fi
fi

cd "$REPO_DIR"

if [[ "${SKIP_ENV_FILE:-0}" != "1" && -f .env ]]; then
  set -a
  source .env
  set +a
fi

export COCO_AGENT_MODE="${COCO_AGENT_MODE:-mock}"
npm start "$@"
status=$?
if [[ $status -eq 0 ]]; then
  mkdir -p "$(dirname "$LAST_SESSION_FILE")"
  date -Iseconds > "$LAST_SESSION_FILE" || true
fi
exit $status
