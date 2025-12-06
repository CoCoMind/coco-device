#!/usr/bin/env bash
# Command poller and executor for Coco agent admin panel integration

set -o pipefail

RUN_USER="${COCO_COMMAND_POLLER_USER:-${SUDO_USER:-${USER:-pi}}}"
RUN_GROUP="${COCO_COMMAND_POLLER_GROUP:-$RUN_USER}"
LOG_FILE="${COCO_COMMAND_POLLER_LOG_FILE:-/var/log/coco/command-poller.log}"
ENV_FILES=("/etc/coco/.env" "/home/${RUN_USER}/coco-device/.env")
LOCK_FILE="/tmp/coco-command-poller.lock"
BACKEND_POLL_PATH="/internal/commands/pending"
BACKEND_STATUS_PATH="/internal/commands"
BACKEND_LOGS_PATH="/internal/ingest/logs"

log() {
  local timestamp
  timestamp=$(date -Iseconds)
  echo "${timestamp} [coco-command-poller] $*" >> "$LOG_FILE"
}

ensure_log_file() {
  mkdir -p "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
  chmod 644 "$LOG_FILE"
  chown "$RUN_USER":"$RUN_GROUP" "$LOG_FILE" 2>/dev/null || true
}

load_env() {
  if [ "${SKIP_ENV_FILE:-0}" = "1" ]; then
    return 1
  fi
  local loaded=1
  for file in "${ENV_FILES[@]}"; do
    if [ -f "$file" ]; then
      # shellcheck disable=SC1090
      set -a
      source "$file"
      set +a
      log "loaded environment from $file"
      loaded=0
      break
    fi
  done
  return $loaded
}

acquire_lock() {
  exec 200>"$LOCK_FILE"
  if ! flock -n 200; then
    log "already running, exiting"
    exit 0
  fi
}

poll_command() {
  local url response http_status
  url="${COCO_BACKEND_URL%/}${BACKEND_POLL_PATH}"

  local response_file
  response_file=$(mktemp)

  http_status=$(curl -s -o "$response_file" -w "%{http_code}" -X GET "$url" \
    -H "Authorization: Bearer ${INGEST_SERVICE_TOKEN}" \
    -H "X-Device-ID: ${COCO_DEVICE_ID}" \
    -H "Content-Type: application/json" \
    --connect-timeout 10 --max-time 15 2>/dev/null) || true

  if [ "$http_status" != "200" ]; then
    log "poll failed (http $http_status)"
    rm -f "$response_file"
    return 1
  fi

  response=$(cat "$response_file")
  rm -f "$response_file"

  COMMAND_ID=$(echo "$response" | python3 -c "import sys, json; d=json.load(sys.stdin); c=d.get('command'); print(c.get('id','') if c else '')" 2>/dev/null || true)
  COMMAND_TYPE=$(echo "$response" | python3 -c "import sys, json; d=json.load(sys.stdin); c=d.get('command'); print(c.get('command_type','') if c else '')" 2>/dev/null || true)

  if [ -z "$COMMAND_ID" ] || [ "$COMMAND_ID" = "None" ]; then
    return 1
  fi

  log "received command: $COMMAND_TYPE ($COMMAND_ID)"
  return 0
}

report_status() {
  local command_id="$1"
  local status="$2"
  local error="${3:-}"

  local url payload
  url="${COCO_BACKEND_URL%/}${BACKEND_STATUS_PATH}/${command_id}/status"

  if [ -n "$error" ]; then
    payload=$(python3 -c "import json; print(json.dumps({'status': '$status', 'error': '''$error'''}))")
  else
    payload=$(python3 -c "import json; print(json.dumps({'status': '$status'}))")
  fi

  local http_status
  http_status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" \
    -H "Authorization: Bearer ${INGEST_SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
    --connect-timeout 10 --max-time 15 \
    -d "$payload" 2>/dev/null) || true

  if [[ "$http_status" =~ ^2 ]]; then
    log "status reported: $status"
  else
    log "failed to report status (http $http_status)"
  fi
}

upload_logs() {
  local content=""
  local tmp_content
  tmp_content=$(mktemp)

  # Collect last 200 lines from each coco log file
  for logfile in /var/log/coco/*.log; do
    if [ -f "$logfile" ]; then
      echo "=== $(basename "$logfile") ===" >> "$tmp_content"
      tail -n 200 "$logfile" 2>/dev/null >> "$tmp_content" || true
      echo "" >> "$tmp_content"
    fi
  done

  # Add journalctl output for coco services (last hour)
  echo "=== journalctl coco-* (1 hour) ===" >> "$tmp_content"
  journalctl -u 'coco-*' --since '1 hour ago' --no-pager 2>/dev/null | tail -n 200 >> "$tmp_content" || true
  echo "" >> "$tmp_content"

  # Add boot log
  echo "=== journalctl -b (boot log) ===" >> "$tmp_content"
  journalctl -b --no-pager 2>/dev/null | tail -n 100 >> "$tmp_content" || true
  echo "" >> "$tmp_content"

  # Network status
  echo "=== Network Status ===" >> "$tmp_content"
  echo "--- ip addr ---" >> "$tmp_content"
  ip addr 2>/dev/null >> "$tmp_content" || true
  echo "" >> "$tmp_content"
  echo "--- iwconfig ---" >> "$tmp_content"
  iwconfig 2>/dev/null >> "$tmp_content" || echo "iwconfig not available" >> "$tmp_content"
  echo "" >> "$tmp_content"
  echo "--- iw dev wlan0 link ---" >> "$tmp_content"
  iw dev wlan0 link 2>/dev/null >> "$tmp_content" || echo "wlan0 not available" >> "$tmp_content"
  echo "" >> "$tmp_content"

  # System info
  echo "=== System Info ===" >> "$tmp_content"
  echo "--- uptime ---" >> "$tmp_content"
  uptime 2>/dev/null >> "$tmp_content" || true
  echo "" >> "$tmp_content"
  echo "--- free -h (memory) ---" >> "$tmp_content"
  free -h 2>/dev/null >> "$tmp_content" || true
  echo "" >> "$tmp_content"
  echo "--- df -h (disk) ---" >> "$tmp_content"
  df -h 2>/dev/null >> "$tmp_content" || true
  echo "" >> "$tmp_content"
  echo "--- CPU temperature ---" >> "$tmp_content"
  if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
    temp=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "0")
    echo "CPU Temp: $((temp / 1000))°C" >> "$tmp_content"
  else
    vcgencmd measure_temp 2>/dev/null >> "$tmp_content" || echo "Temperature not available" >> "$tmp_content"
  fi
  echo "" >> "$tmp_content"

  # Read content from temp file
  content=$(cat "$tmp_content")
  rm -f "$tmp_content"

  local url
  url="${COCO_BACKEND_URL%/}${BACKEND_LOGS_PATH}"

  # Use python to properly escape the content for JSON
  local payload
  payload=$(python3 -c "
import json, sys
content = sys.stdin.read()
print(json.dumps({
    'device_id': '${COCO_DEVICE_ID}',
    'content': content
}))
" <<< "$content")

  local http_status
  http_status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" \
    -H "Authorization: Bearer ${INGEST_SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
    --connect-timeout 10 --max-time 30 \
    -d "$payload" 2>/dev/null) || true

  if [[ "$http_status" =~ ^2 ]]; then
    log "logs uploaded successfully"
  else
    log "failed to upload logs (http $http_status)"
    return 1
  fi
}

execute_command() {
  local cmd_type="$1"

  case "$cmd_type" in
    REBOOT)
      log "executing REBOOT"
      # Report status before reboot since we won't be able to after
      report_status "$COMMAND_ID" "COMPLETED"
      sync
      sudo reboot
      ;;
    RESTART_SERVICE)
      log "executing RESTART_SERVICE"
      sudo systemctl restart coco-agent.service
      ;;
    UPLOAD_LOGS)
      log "executing UPLOAD_LOGS"
      upload_logs
      ;;
    UPDATE_NOW)
      log "executing UPDATE_NOW"
      sudo /usr/local/bin/coco-update.sh
      ;;
    *)
      log "unknown command: $cmd_type"
      echo "Unknown command: $cmd_type"
      return 1
      ;;
  esac
}

main() {
  ensure_log_file
  acquire_lock
  load_env || log "no env file found"

  # Validate required environment variables
  missing=()
  [ -z "${COCO_DEVICE_ID:-}" ] && missing+=("COCO_DEVICE_ID")
  [ -z "${COCO_BACKEND_URL:-}" ] && missing+=("COCO_BACKEND_URL")
  [ -z "${INGEST_SERVICE_TOKEN:-}" ] && missing+=("INGEST_SERVICE_TOKEN")

  if [ ${#missing[@]} -gt 0 ]; then
    log "missing config: ${missing[*]}"
    exit 1
  fi

  # Poll for pending command
  if ! poll_command; then
    exit 0
  fi

  # Execute command and report status
  # Note: REBOOT reports status before executing since it won't return
  if [ "$COMMAND_TYPE" = "REBOOT" ]; then
    execute_command "$COMMAND_TYPE"
  else
    local error_msg
    if error_msg=$(execute_command "$COMMAND_TYPE" 2>&1); then
      log "command completed successfully"
      report_status "$COMMAND_ID" "COMPLETED"
    else
      log "command failed: $error_msg"
      report_status "$COMMAND_ID" "FAILED" "$error_msg"
    fi
  fi
}

main "$@"
