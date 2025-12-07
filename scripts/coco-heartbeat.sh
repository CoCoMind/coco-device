#!/usr/bin/env bash
# Device heartbeat sender for Coco agent

set -o pipefail

RUN_USER="${COCO_HEARTBEAT_USER:-${SUDO_USER:-${USER:-pi}}}"
RUN_GROUP="${COCO_HEARTBEAT_GROUP:-$RUN_USER}"
LOG_FILE="${COCO_HEARTBEAT_LOG_FILE:-/var/log/coco/heartbeat.log}"
ENV_FILES=("/etc/coco/.env" "/home/${RUN_USER}/coco-device/.env")
AGENT_VERSION_FILE="/etc/coco-agent-version"
LAST_SESSION_FILE="/var/lib/coco/last_session_at"
BACKEND_PATH="/internal/heartbeat"

log() {
  local timestamp
  timestamp=$(date -Iseconds)
  echo "${timestamp} [coco-heartbeat] $*" >> "$LOG_FILE"
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

read_agent_version() {
  if [ -n "${COCO_AGENT_VERSION:-}" ]; then
    AGENT_VERSION="$COCO_AGENT_VERSION"
    return
  fi
  if [ -f "$AGENT_VERSION_FILE" ]; then
    AGENT_VERSION="$(tr -d '\n' < "$AGENT_VERSION_FILE")"
  else
    AGENT_VERSION=""
  fi
}

get_ip_for_iface() {
  local iface="$1"
  ip -4 addr show dev "$iface" 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -n1
}

collect_connectivity() {
  CONNECTIVITY="offline"
  NETWORK_IFACE=""
  IP_ADDRESS=""
  RSSI=""

  local wlan_ip
  wlan_ip=$(get_ip_for_iface "wlan0")
  if [ -n "$wlan_ip" ]; then
    CONNECTIVITY="wifi"
    NETWORK_IFACE="wlan0"
    IP_ADDRESS="$wlan_ip"
    RSSI=$(iw dev wlan0 link 2>/dev/null | awk '/signal:/ {print $2}' | head -n1)
    return
  fi

  for iface in wwan0 usb0; do
    local lte_ip
    lte_ip=$(get_ip_for_iface "$iface")
    if [ -n "$lte_ip" ]; then
      CONNECTIVITY="lte"
      NETWORK_IFACE="$iface"
      IP_ADDRESS="$lte_ip"
      return
    fi
  done

  # Check ethernet as fallback (report as "wifi" since backend only accepts wifi/lte/offline)
  for iface in eth0 eth1 enp0s3; do
    local eth_ip
    eth_ip=$(get_ip_for_iface "$iface")
    if [ -n "$eth_ip" ]; then
      CONNECTIVITY="wifi"
      NETWORK_IFACE="$iface"
      IP_ADDRESS="$eth_ip"
      return
    fi
  done
}

measure_latency() {
  LATENCY_MS=""
  if [ "$CONNECTIVITY" = "offline" ]; then
    return
  fi
  if [ "${COCO_SKIP_LATENCY:-}" = "1" ]; then
    return
  fi
  # Measure latency to the backend's healthz endpoint
  local url total
  url="${COCO_BACKEND_URL%/}/healthz"
  total=$(curl -o /dev/null -s -w "%{time_total}" --max-time 5 "$url" 2>/dev/null)
  if [ -n "$total" ]; then
    LATENCY_MS=$(python3 - "$total" <<'PY'
import sys
val = sys.argv[1]
try:
    ms = round(float(val) * 1000)
    print(int(ms))
except Exception:
    pass
PY
)
  fi
}

read_last_session() {
  if [ -f "$LAST_SESSION_FILE" ]; then
    LAST_SESSION_AT="$(tr -d '\n' < "$LAST_SESSION_FILE")"
  else
    LAST_SESSION_AT=""
    log "last_session_at missing"
  fi
}

read_boot_time() {
  # Calculate boot time from /proc/uptime
  if [ -f /proc/uptime ]; then
    local uptime_seconds
    uptime_seconds=$(cut -d' ' -f1 < /proc/uptime)
    # Remove decimal portion for arithmetic
    local uptime_int=${uptime_seconds%.*}
    local now_epoch
    now_epoch=$(date +%s)
    local boot_epoch=$((now_epoch - uptime_int))
    BOOT_TIME=$(date -u -d "@$boot_epoch" --iso-8601=seconds)
  else
    BOOT_TIME=""
    log "could not read boot time from /proc/uptime"
  fi
}

map_agent_status() {
  local state
  state=$(systemctl is-active coco-agent.service 2>/dev/null || true)
  case "$state" in
    active)
      AGENT_STATUS="ok"
      ;;
    inactive)
      AGENT_STATUS="ok"
      ;;
    activating|deactivating)
      AGENT_STATUS="degraded"
      ;;
    failed)
      AGENT_STATUS="crashed"
      ;;
    *)
      AGENT_STATUS="degraded"
      ;;
  esac
}

build_payload() {
  PAYLOAD=$(python3 - <<'PY'
import json, os, sys

def none_if_empty(val):
    if val is None:
        return None
    val = str(val).strip()
    return None if val == "" else val

payload = {
    "device_id": os.environ.get("COCO_DEVICE_ID", ""),
    "agent_version": os.environ.get("AGENT_VERSION", ""),
    "connectivity": os.environ.get("CONNECTIVITY", "offline"),
    "network": {
        "interface": none_if_empty(os.environ.get("NETWORK_IFACE")),
        "ip": none_if_empty(os.environ.get("IP_ADDRESS")),
        "signal_rssi": int(os.environ.get("RSSI")) if os.environ.get("RSSI") else None,
        "latency_ms": int(os.environ.get("LATENCY_MS")) if os.environ.get("LATENCY_MS") else None,
    },
    "agent_status": os.environ.get("AGENT_STATUS", "degraded"),
    "last_session_at": none_if_empty(os.environ.get("LAST_SESSION_AT")),
    "boot_time": none_if_empty(os.environ.get("BOOT_TIME")),
}
print(json.dumps(payload))
PY
)
}

send_payload() {
  local payload_file response_file http_status attempt=1 success=1
  payload_file=$(mktemp)
  response_file=$(mktemp)
  echo "$PAYLOAD" > "$payload_file"
  local url
  url="${COCO_BACKEND_URL%/}$BACKEND_PATH"
  while [ $attempt -le 2 ]; do
    http_status=$(curl -s -o "$response_file" -w "%{http_code}" -X POST "$url" \
      -H "Authorization: Bearer ${INGEST_SERVICE_TOKEN}" \
      -H "Content-Type: application/json" \
      --connect-timeout 5 --max-time 10 \
      --data "@$payload_file")
    exit_code=$?
    if [ $exit_code -eq 0 ] && [[ "$http_status" =~ ^2 ]]; then
      log "heartbeat sent (attempt $attempt, status $http_status)"
      success=0
      break
    else
      log "heartbeat attempt $attempt failed (exit $exit_code, http $http_status): $(cat "$response_file")"
      attempt=$((attempt + 1))
      sleep 2
    fi
  done
  if [ $success -ne 0 ]; then
    log "heartbeat failed after retries"
  fi
  rm -f "$payload_file" "$response_file"
}

main() {
  ensure_log_file
  load_env || log "no env file found"
  read_agent_version
  collect_connectivity
  measure_latency
  read_last_session
  read_boot_time
  map_agent_status

  missing=()
  [ -z "${COCO_DEVICE_ID:-}" ] && missing+=("COCO_DEVICE_ID")
  [ -z "${COCO_BACKEND_URL:-}" ] && missing+=("COCO_BACKEND_URL")
  [ -z "${INGEST_SERVICE_TOKEN:-}" ] && missing+=("INGEST_SERVICE_TOKEN")
  [ -z "${AGENT_VERSION:-}" ] && missing+=("AGENT_VERSION")

  if [ ${#missing[@]} -gt 0 ]; then
    log "missing config: ${missing[*]}"
    AGENT_STATUS="crashed"
  fi

  export CONNECTIVITY NETWORK_IFACE IP_ADDRESS RSSI LATENCY_MS LAST_SESSION_AT BOOT_TIME AGENT_STATUS AGENT_VERSION
  build_payload

  if [ ${#missing[@]} -gt 0 ] && { [ -z "${COCO_BACKEND_URL:-}" ] || [ -z "${INGEST_SERVICE_TOKEN:-}" ]; }; then
    log "skipping POST because backend URL or token missing"
    echo "$PAYLOAD" > /tmp/coco-heartbeat-last.json
    return
  fi

  send_payload
}

main "$@"
