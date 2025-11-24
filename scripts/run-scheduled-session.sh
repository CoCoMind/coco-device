#!/usr/bin/env bash
set -euo pipefail

RUN_USER="${COCO_RUN_USER:-${SUDO_USER:-${USER}}}"
ROOT_DIR="${COCO_REPO_DIR:-/home/${RUN_USER}/coco-device}"
LOG_FILE="${LOG_FILE:-/var/log/coco/session-scheduler.log}"
LOCK_FILE="${LOCK_FILE:-/tmp/coco-session-runner.lock}"
LAST_SESSION_FILE="${LAST_SESSION_FILE:-/var/lib/coco/last_session_at}"
NETWORK_RETRY_SECONDS="${NETWORK_RETRY_SECONDS:-300}"
MAX_NETWORK_ATTEMPTS="${MAX_NETWORK_ATTEMPTS:-12}"
SESSION_CMD="${SESSION_CMD:-/usr/local/bin/coco-native-agent-boot.sh}"
CONNECTIVITY_PROBE="${CONNECTIVITY_PROBE:-https://www.google.com/generate_204}"

log() {
  local ts
  ts=$(date -Iseconds)
  echo "[$ts] $*" | tee -a "$LOG_FILE"
}

load_env() {
  if [[ -f "${ROOT_DIR}/.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ROOT_DIR}/.env"
    set +a
  fi
}

check_network_once() {
  local http_code
  http_code=$(curl -s --max-time 5 --connect-timeout 3 -o /dev/null -w "%{http_code}" "$CONNECTIVITY_PROBE" || true)
  if [[ -n "$http_code" && "$http_code" != "000" ]]; then
    return 0
  fi
  if ping -c1 -W3 1.1.1.1 >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

wait_for_network() {
  local attempt=1
  while (( attempt <= MAX_NETWORK_ATTEMPTS )); do
    if check_network_once; then
      log "Network reachable (attempt ${attempt}/${MAX_NETWORK_ATTEMPTS})."
      return 0
    fi
    log "Network unavailable (attempt ${attempt}/${MAX_NETWORK_ATTEMPTS}); retrying in ${NETWORK_RETRY_SECONDS}s."
    sleep "${NETWORK_RETRY_SECONDS}"
    attempt=$((attempt + 1))
  done
  log "Network unavailable after ${MAX_NETWORK_ATTEMPTS} attempts; session will be skipped."
  return 1
}

ensure_lock() {
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    log "Another Coco session is already running; skipping this invocation."
    exit 0
  fi
}

run_session() {
  local start_ts end_ts start_epoch end_epoch status sentiment
  start_ts=$(date -Iseconds)
  start_epoch=$(date +%s)
  sentiment="${COCO_SENTIMENT_SUMMARY:-positive}"

  log "Starting scheduled Coco session (mode=${COCO_AGENT_MODE:-unset}, sentiment=${sentiment})."
  if "${SESSION_CMD}" >> "${LOG_FILE}" 2>&1; then
    status="success"
  else
    status="failed"
  fi
  end_ts=$(date -Iseconds)
  end_epoch=$(date +%s)
  log "Session finished status=${status} start=${start_ts} end=${end_ts} duration_seconds=$((end_epoch - start_epoch)) sentiment_summary=${sentiment}"
  mkdir -p "$(dirname "$LAST_SESSION_FILE")"
  printf '%s\n' "$end_ts" > "$LAST_SESSION_FILE"
}

main() {
  mkdir -p "$(dirname "${LOG_FILE}")"
  load_env
  ensure_lock

  if ! command -v flock >/dev/null 2>&1; then
    log "flock not found; install util-linux."
    exit 1
  fi
  if [[ ! -x "${SESSION_CMD}" ]]; then
    log "Session command not executable or missing: ${SESSION_CMD}"
    exit 1
  fi

  if wait_for_network; then
    run_session
  fi
}

main "$@"
