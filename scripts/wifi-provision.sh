#!/usr/bin/env bash
set -euo pipefail

# Wi-Fi provisioning loop that watches for wifi.conf files on removable storage.
# Intended to run as root on Raspberry Pi OS or similar distributions.

LOG_FILE="/var/log/coco/wifi-provision.log"
STATE_DIR="/var/lib/wifi-provision"
USB_SEARCH_PATHS=(/media /run/media /mnt)
WLAN_IFACE="${WLAN_IFACE:-wlan0}"
LOOP_DELAY_SECONDS="${LOOP_DELAY_SECONDS:-15}"
CONNECT_TIMEOUT_SECONDS="${CONNECT_TIMEOUT_SECONDS:-45}"
AUDIO_DEVICE="${AUDIO_DEVICE:-default}"
APPLIED_SUFFIX=".applied"
FAILED_SUFFIX=".failed"

mkdir -p "$STATE_DIR"
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

log() {
  local timestamp message
  timestamp="$(date --iso-8601=seconds)"
  message="[$timestamp] $*"
  echo "$message" | tee -a "$LOG_FILE" >&2
}

speak() {
  local text="$1" played=false
  if command -v espeak >/dev/null 2>&1; then
    if command -v aplay >/dev/null 2>&1; then
      if espeak --stdout "$text" 2>/dev/null | aplay -q -D "$AUDIO_DEVICE" >/dev/null 2>&1; then
        played=true
      fi
    fi
    if [[ "$played" != true ]] && espeak "$text" >/dev/null 2>&1; then
      played=true
    fi
  elif command -v pico2wave >/dev/null 2>&1 && command -v aplay >/dev/null 2>&1; then
    local tmpfile
    tmpfile="$(mktemp --suffix=.wav)"
    if pico2wave -w "$tmpfile" "$text" >/dev/null 2>&1; then
      if aplay -q -D "$AUDIO_DEVICE" "$tmpfile" >/dev/null 2>&1; then
        played=true
      fi
    fi
    rm -f "$tmpfile"
  fi
  if [[ "$played" != true ]]; then
    log "Audio announcement unavailable; install espeak or pico2wave+aplay and set AUDIO_DEVICE if needed"
  fi
}

trim() {
  local var="$1"
  var="${var#"${var%%[![:space:]]*}"}"
  var="${var%"${var##*[![:space:]]}"}"
  printf '%s' "$var"
}

extract_value() {
  local key="$1"
  local file="$2"
  local line value
  line="$(grep -m1 -i "^${key}[[:space:]]*=" "$file" || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi
  value="${line#*=}"
  value="$(trim "$value")"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

current_ssid() {
  iwgetid -r 2>/dev/null || true
}

list_network_id_for_ssid() {
  local target_ssid="$1"
  wpa_cli -i "$WLAN_IFACE" list_networks 2>/dev/null | awk -v s="$target_ssid" '$2 == s {print $1; exit}'
}

list_usb_mount_points() {
  local entry mountpath
  declare -A usb_roots=()
  declare -A seen_mounts=()

  command -v lsblk >/dev/null 2>&1 || return 0

  while read -r entry; do
    unset KNAME PKNAME TRAN MOUNTPOINT
    eval "$entry"
    if [[ "${TRAN:-}" == "usb" && -n "${KNAME:-}" ]]; then
      usb_roots["$KNAME"]=1
    fi
  done < <(lsblk -npo KNAME,PKNAME,TRAN,MOUNTPOINT -P 2>/dev/null)

  while read -r entry; do
    unset KNAME PKNAME TRAN MOUNTPOINT
    eval "$entry"
    [[ -n "${MOUNTPOINT:-}" ]] || continue
    printf -v mountpath '%b' "$MOUNTPOINT"
    [[ -d "$mountpath" ]] || continue
    if [[ -n "${usb_roots[${KNAME:-}]+x}" || -n "${usb_roots[${PKNAME:-}]+x}" ]]; then
      if [[ -z "${seen_mounts[$mountpath]+x}" ]]; then
        printf '%s\n' "$mountpath"
        seen_mounts["$mountpath"]=1
      fi
    fi
  done < <(lsblk -npo KNAME,PKNAME,TRAN,MOUNTPOINT -P 2>/dev/null)
}

find_wifi_conf() {
  local -a search_paths=("$@")
  local base
  declare -A seen=()

  if [[ ${#search_paths[@]} -eq 0 ]]; then
    search_paths=("${USB_SEARCH_PATHS[@]}")
  else
    search_paths+=("${USB_SEARCH_PATHS[@]}")
  fi

  for base in "${search_paths[@]}"; do
    [[ -n "$base" && -d "$base" ]] || continue
    if [[ -n "${seen[$base]+x}" ]]; then
      continue
    fi
    seen["$base"]=1
    while IFS= read -r -d '' match; do
      echo "$match"
      return 0
    done < <(find "$base" -maxdepth 3 -type f -name 'wifi.conf' -print0 2>/dev/null)
  done
  return 1
}

wait_for_connection() {
  local target_ssid="$1"
  local deadline=$((SECONDS + CONNECT_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    local status state current
    status="$(wpa_cli -i "$WLAN_IFACE" status 2>/dev/null || true)"
    state="$(grep -m1 '^wpa_state=' <<<"$status" | cut -d= -f2)"
    current="$(grep -m1 '^ssid=' <<<"$status" | cut -d= -f2)"
    if [[ "$state" == "COMPLETED" && "$current" == "$target_ssid" ]]; then
      return 0
    fi
    sleep 3
  done
  return 1
}

apply_credentials() {
  local conf_file="$1"
  local ssid psk hidden priority network_id existing_id new_name failed_name disabled_existing=false

  ssid="$(extract_value "ssid" "$conf_file" || extract_value "SSID" "$conf_file" || true)"
  psk="$(extract_value "psk" "$conf_file" || extract_value "PSK" "$conf_file" || true)"
  hidden="$(extract_value "hidden" "$conf_file" || extract_value "HIDDEN" "$conf_file" || true)"
  priority="$(extract_value "priority" "$conf_file" || extract_value "PRIORITY" "$conf_file" || true)"

  if [[ -z "$ssid" ]]; then
    log "wifi.conf missing ssid entry; leaving file untouched: $conf_file"
    return 1
  fi

  log "Applying Wi-Fi credentials for SSID '$ssid' from $conf_file"
  speak "Attempting Wi-Fi connection to ${ssid}"

  existing_id="$(list_network_id_for_ssid "$ssid" || true)"
  if [[ -n "$existing_id" ]]; then
    log "Temporarily disabling existing network id $existing_id for SSID '$ssid'"
    if wpa_cli -i "$WLAN_IFACE" disable_network "$existing_id" >/dev/null 2>&1; then
      disabled_existing=true
    fi
  fi

  network_id="$(wpa_cli -i "$WLAN_IFACE" add_network | tail -n1)"
  if [[ -z "$network_id" ]]; then
    log "Failed to allocate new network via wpa_cli"
    [[ "$disabled_existing" == true && -n "$existing_id" ]] && wpa_cli -i "$WLAN_IFACE" enable_network "$existing_id" >/dev/null 2>&1
    return 1
  fi

  wpa_cli -i "$WLAN_IFACE" set_network "$network_id" ssid "\"$ssid\"" >/dev/null

  if [[ -n "$psk" ]]; then
    wpa_cli -i "$WLAN_IFACE" set_network "$network_id" psk "\"$psk\"" >/dev/null
  else
    log "PSK not provided; assuming open network for '$ssid'"
    wpa_cli -i "$WLAN_IFACE" set_network "$network_id" key_mgmt NONE >/dev/null
  fi

  if [[ "$hidden" =~ ^(1|yes|true)$ ]]; then
    wpa_cli -i "$WLAN_IFACE" set_network "$network_id" scan_ssid 1 >/dev/null
  fi

  if [[ -n "$priority" ]]; then
    wpa_cli -i "$WLAN_IFACE" set_network "$network_id" priority "$priority" >/dev/null
  fi

  wpa_cli -i "$WLAN_IFACE" enable_network "$network_id" >/dev/null
  wpa_cli -i "$WLAN_IFACE" select_network "$network_id" >/dev/null
  wpa_cli -i "$WLAN_IFACE" reassociate >/dev/null

  log "Waiting up to ${CONNECT_TIMEOUT_SECONDS}s for connection to '$ssid'"
  if wait_for_connection "$ssid"; then
    log "Connection confirmed for SSID '$ssid'"
    new_name="${conf_file}${APPLIED_SUFFIX}-$(date +%Y%m%d%H%M%S)"
    if mv "$conf_file" "$new_name"; then
      log "Renamed $conf_file to $new_name after successfully applying credentials"
    else
      log "Warning: Failed to rename $conf_file to mark as applied"
    fi
    if [[ -n "$existing_id" ]]; then
      wpa_cli -i "$WLAN_IFACE" remove_network "$existing_id" >/dev/null 2>&1 || true
    fi
    wpa_cli -i "$WLAN_IFACE" save_config >/dev/null
    return 0
  fi

  log "Failed to connect to SSID '$ssid' within timeout; marking credentials as invalid"
  speak "Wi-Fi connection failed for ${ssid}. Please check credentials."

  failed_name="${conf_file}${FAILED_SUFFIX}-$(date +%Y%m%d%H%M%S)"
  if mv "$conf_file" "$failed_name"; then
    log "Renamed $conf_file to $failed_name to prevent repeated attempts"
  else
    log "Warning: Failed to rename $conf_file to mark as failed"
  fi

  wpa_cli -i "$WLAN_IFACE" remove_network "$network_id" >/dev/null 2>&1 || true

  if [[ "$disabled_existing" == true && -n "$existing_id" ]]; then
    wpa_cli -i "$WLAN_IFACE" enable_network "$existing_id" >/dev/null 2>&1 || true
    wpa_cli -i "$WLAN_IFACE" select_network "$existing_id" >/dev/null 2>&1 || true
  fi

  wpa_cli -i "$WLAN_IFACE" save_config >/dev/null
  return 1
}

main_loop() {
  local last_announce_ssid="" last_seen_conf="" last_no_conf_logged=false last_usb_signature=""
  while true; do
    local conf ssid usb_signature
    local -a usb_mounts=()

    while IFS= read -r mount; do
      usb_mounts+=("$mount")
    done < <(list_usb_mount_points || true)

    usb_signature="$(printf '%s|' "${usb_mounts[@]}")"
    if [[ "$usb_signature" != "$last_usb_signature" ]]; then
      if ((${#usb_mounts[@]} > 0)); then
        log "USB storage detected at: ${usb_mounts[*]}"
        speak "USB storage detected"
      else
        log "No USB storage detected; watching ${USB_SEARCH_PATHS[*]} for wifi.conf"
        speak "USB storage not detected"
      fi
      last_usb_signature="$usb_signature"
      last_no_conf_logged=false
    fi

    if ((${#usb_mounts[@]} > 0)); then
      conf="$(find_wifi_conf "${usb_mounts[@]}" || true)"
    else
      conf="$(find_wifi_conf || true)"
    fi

    if [[ -n "$conf" ]]; then
      if [[ "$conf" != "$last_seen_conf" ]]; then
        log "Detected provisioning file $conf"
        speak "Wi-Fi provisioning USB detected"
        last_seen_conf="$conf"
      fi
      apply_credentials "$conf" || log "Failed to apply credentials from $conf"
      last_seen_conf=""
      last_no_conf_logged=false
    else
      if ((${#usb_mounts[@]} == 0)); then
        last_seen_conf=""
        last_no_conf_logged=false
      elif [[ "$last_no_conf_logged" != true ]]; then
        log "No wifi.conf found on attached storage; waiting..."
        speak "No Wi-Fi configuration file found on the USB drive"
        last_no_conf_logged=true
      fi
    fi

    ssid="$(current_ssid)"
    if [[ -n "$ssid" ]]; then
      if [[ "$ssid" != "$last_announce_ssid" ]]; then
        log "Connected to Wi-Fi SSID '$ssid'"
        echo "$ssid" >"$STATE_DIR/last-connected-ssid"
        speak "Wi-Fi connected to ${ssid}"
        last_announce_ssid="$ssid"
      fi
    else
      last_announce_ssid=""
    fi

    sleep "$LOOP_DELAY_SECONDS"
  done
}

log "Starting Wi-Fi provisioning loop on interface $WLAN_IFACE"
log "Audio device for announcements: $AUDIO_DEVICE"
main_loop
