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
API_DNS_CHECK="${API_DNS_CHECK:-api.openai.com}"
MIN_SESSION_SECONDS="${MIN_SESSION_SECONDS:-10}"

log() {
  local ts
  ts=$(date -Iseconds)
  echo "[$ts] $*" | tee -a "$LOG_FILE"
}

ensure_log_file() {
  mkdir -p "$(dirname "${LOG_FILE}")"
  touch "${LOG_FILE}"
  chmod 644 "${LOG_FILE}" 2>/dev/null || true
  chown "${RUN_USER}":"${RUN_USER}" "${LOG_FILE}" 2>/dev/null || true
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
  if [[ -z "$http_code" || "$http_code" == "000" ]]; then
    if ! ping -c1 -W3 1.1.1.1 >/dev/null 2>&1; then
      return 1
    fi
  fi
  # Also verify DNS resolution for the API endpoint
  if ! getent hosts "$API_DNS_CHECK" >/dev/null 2>&1; then
    log "DNS resolution failed for ${API_DNS_CHECK}"
    return 1
  fi
  return 0
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
  if [[ -e "${LOCK_FILE}" && ! -w "${LOCK_FILE}" ]]; then
    rm -f "${LOCK_FILE}" 2>/dev/null || true
  fi
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    log "Another Coco session is already running; skipping this invocation."
    exit 0
  fi
}

run_session() {
  local start_ts end_ts start_epoch end_epoch duration status sentiment exit_code
  start_ts=$(date -Iseconds)
  start_epoch=$(date +%s)
  sentiment="${COCO_SENTIMENT_SUMMARY:-positive}"

  log "Starting scheduled Coco session."
  export SKIP_AGENT_LOCK=1

  # Run the session and capture exit code
  set +e
  bash -lc "${SESSION_CMD}" >> "${LOG_FILE}" 2>&1
  exit_code=$?
  set -e

  end_ts=$(date -Iseconds)
  end_epoch=$(date +%s)
  duration=$((end_epoch - start_epoch))

  # Determine status based on exit code AND duration
  # Exit codes: 0=success, 1=failed, 2=unattended (no user input)
  if [[ $exit_code -eq 2 ]]; then
    status="unattended"
    log "Session completed but no user input detected (exit code 2)"
  elif [[ $exit_code -ne 0 ]]; then
    status="failed"
    log "Session exited with code ${exit_code}"
  elif [[ $duration -lt $MIN_SESSION_SECONDS ]]; then
    status="crashed"
    log "Session finished too quickly (${duration}s < ${MIN_SESSION_SECONDS}s minimum) - likely crashed"
  else
    status="success"
  fi

  log "Session finished status=${status} start=${start_ts} end=${end_ts} duration_seconds=${duration} sentiment_summary=${sentiment}"
  mkdir -p "$(dirname "$LAST_SESSION_FILE")"
  printf '%s\n' "$end_ts" > "$LAST_SESSION_FILE"

  # Return non-zero if session failed or crashed (unattended is not a failure)
  [[ "$status" == "success" || "$status" == "unattended" ]]
}

main() {
  ensure_log_file
  load_env
  ensure_lock

  if ! command -v flock >/dev/null 2>&1; then
    log "flock not found; install util-linux."
    exit 1
  fi
  local cmd_bin="${SESSION_CMD%% *}"
  if ! command -v "${cmd_bin}" >/dev/null 2>&1; then
    log "Session command not executable or missing: ${SESSION_CMD}"
    exit 1
  fi

  if wait_for_network; then
    run_session
  fi
}

main "$@"
