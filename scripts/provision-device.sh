#!/usr/bin/env bash
# provision-device.sh - Set up a new Coco device for deployment
# Usage: sudo ./scripts/provision-device.sh

set -euo pipefail

# Detect the actual user (not root when running with sudo)
COCO_USER="${SUDO_USER:-${USER:-pi}}"
COCO_HOME=$(getent passwd "$COCO_USER" | cut -d: -f6 || echo "/home/${COCO_USER}")
COCO_DIR="${COCO_DIR:-${COCO_HOME}/coco-device}"
ENV_FILE="${COCO_DIR}/.env"
VERSION_FILE="/etc/coco-agent-version"
LOGROTATE_SRC="${COCO_DIR}/config/logrotate-coco"
LOGROTATE_DEST="/etc/logrotate.d/coco"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    log_error "This script must be run as root (use sudo)"
    exit 1
fi

echo "============================================"
echo "  Coco Device Provisioning"
echo "============================================"
echo ""

# Check WiFi/network connectivity status
check_network_status() {
    # Check if NetworkManager is available
    if ! command -v nmcli &>/dev/null; then
        log_warn "NetworkManager not found - WiFi provisioning unavailable"
        return 0
    fi

    local wifi_connection
    wifi_connection=$(nmcli -t -f NAME,TYPE c show --active 2>/dev/null | grep wifi | cut -d: -f1)
    local eth_connection
    eth_connection=$(nmcli -t -f NAME,TYPE c show --active 2>/dev/null | grep ethernet | cut -d: -f1)

    if [[ -n "$wifi_connection" ]]; then
        log_info "WiFi connected to: $wifi_connection"
    elif [[ -n "$eth_connection" ]]; then
        log_info "Ethernet connected: $eth_connection"
    else
        log_warn "No network connection detected"
        echo ""
        echo "To configure WiFi, look for a hotspot named 'CoCo-XXXX'"
        echo "Connect to it from your phone/laptop and a captive portal"
        echo "will appear to select your WiFi network."
        echo ""
        read -p "Continue provisioning anyway? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Configure WiFi first, then re-run this script."
            exit 0
        fi
    fi
}

# Check network status before proceeding
check_network_status

# Setup SSH deploy key for GitHub access
setup_ssh_deploy_key() {
    local user_home="$1"
    local ssh_dir="${user_home}/.ssh"
    local key_file="${ssh_dir}/coco-deploy"
    local config_file="${ssh_dir}/config"

    log_info "Setting up SSH deploy key for GitHub..."

    mkdir -p "$ssh_dir"
    chmod 700 "$ssh_dir"

    # Install deploy key (read-only access to coco-hardware-scripts repo)
    cat > "$key_file" << 'DEPLOY_KEY'
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCARSJ5hE35fv0lnqsvEZ3wBnZ57CFBoxGfo/DosSagtQAAAKBcAcJDXAHC
QwAAAAtzc2gtZWQyNTUxOQAAACCARSJ5hE35fv0lnqsvEZ3wBnZ57CFBoxGfo/DosSagtQ
AAAEDyYvtPQh5lmmCKJTXFM1AF7jeKI8798UpqITMx9g00ZoBFInmETfl+/SWeqy8RnfAG
dnnsIUGjEZ+j8OixJqC1AAAAFmNvY28tZGV2aWNlLWRlcGxveS1rZXkBAgMEBQYH
-----END OPENSSH PRIVATE KEY-----
DEPLOY_KEY
    chmod 600 "$key_file"

    # Configure SSH to use deploy key for GitHub
    if ! grep -q "Host github.com" "$config_file" 2>/dev/null; then
        cat >> "$config_file" << 'SSH_CONFIG'

# Coco device deploy key for GitHub
Host github.com
    IdentityFile ~/.ssh/coco-deploy
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
SSH_CONFIG
    fi
    chmod 600 "$config_file"

    # Add GitHub to known_hosts
    if ! grep -q "github.com" "${ssh_dir}/known_hosts" 2>/dev/null; then
        ssh-keyscan github.com >> "${ssh_dir}/known_hosts" 2>/dev/null
    fi

    log_info "SSH deploy key configured"
}

# Check for existing .env
if [[ -f "$ENV_FILE" ]]; then
    log_warn ".env already exists at $ENV_FILE"
    read -p "Overwrite existing configuration? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Keeping existing configuration"
        exit 0
    fi
fi

# Prompt for required values
echo ""
log_info "Enter configuration values (press Enter for defaults where shown)"
echo ""

# Participant ID (required)
while true; do
    read -p "Participant ID (e.g., participant-001): " PARTICIPANT_ID
    if [[ -n "$PARTICIPANT_ID" ]]; then
        break
    fi
    log_error "Participant ID is required"
done

# Device ID (auto-generate or custom)
DEFAULT_DEVICE_ID="coco-$(hostname)-$(date +%s | tail -c 5)"
read -p "Device ID [${DEFAULT_DEVICE_ID}]: " DEVICE_ID
DEVICE_ID="${DEVICE_ID:-$DEFAULT_DEVICE_ID}"

# Backend URL
read -p "Backend URL [https://coco-backend.fly.dev]: " BACKEND_URL
BACKEND_URL="${BACKEND_URL:-https://coco-backend.fly.dev}"

# Ingest token
read -p "Ingest Service Token: " INGEST_TOKEN
if [[ -z "$INGEST_TOKEN" ]]; then
    log_warn "No ingest token provided - session data won't be sent to backend"
fi

# OpenAI API Key
read -p "OpenAI API Key: " OPENAI_KEY
if [[ -z "$OPENAI_KEY" ]]; then
    log_error "OpenAI API Key is required for TTS/STT/LLM"
    exit 1
fi

# Audio device configuration
echo ""
log_info "Audio device configuration (run 'aplay -l' to list devices)"
read -p "Audio Output Device [pulse]: " AUDIO_OUT
AUDIO_OUT="${AUDIO_OUT:-pulse}"
read -p "Audio Input Device [pulse]: " AUDIO_IN
AUDIO_IN="${AUDIO_IN:-pulse}"

# Write .env file
log_info "Writing configuration to $ENV_FILE"
cat > "$ENV_FILE" << EOF
# Coco Device Configuration
# Generated by provision-device.sh on $(date -Iseconds)

# ============================================
# Identity & Backend
# ============================================
COCO_DEVICE_ID=${DEVICE_ID}
COCO_USER_EXTERNAL_ID=${PARTICIPANT_ID}
COCO_PARTICIPANT_ID=${PARTICIPANT_ID}
COCO_BACKEND_URL=${BACKEND_URL}
INGEST_SERVICE_TOKEN=${INGEST_TOKEN}

# ============================================
# OpenAI
# ============================================
OPENAI_API_KEY=${OPENAI_KEY}

# ============================================
# Audio Hardware (ALSA)
# ============================================
COCO_AUDIO_OUTPUT_DEVICE=${AUDIO_OUT}
COCO_AUDIO_INPUT_DEVICE=${AUDIO_IN}
COCO_AUDIO_DISABLE=0

# ============================================
# Logging
# ============================================
COCO_LOG_LEVEL=info
EOF

# Set proper ownership
chown "${COCO_USER}:${COCO_USER}" "$ENV_FILE"
chmod 600 "$ENV_FILE"
log_info ".env file created with secure permissions"

# Setup SSH deploy key for this user
setup_ssh_deploy_key "$COCO_HOME"
chown -R "${COCO_USER}:${COCO_USER}" "${COCO_HOME}/.ssh"

# Write version file
AGENT_VERSION=$(cd "$COCO_DIR" && git describe --tags --always 2>/dev/null || echo "unknown")
echo "$AGENT_VERSION" > "$VERSION_FILE"
log_info "Version file written: $AGENT_VERSION"

# Install logrotate config
if [[ -f "$LOGROTATE_SRC" ]]; then
    cp "$LOGROTATE_SRC" "$LOGROTATE_DEST"
    log_info "Logrotate configuration installed"
else
    log_warn "Logrotate config not found at $LOGROTATE_SRC"
fi

# Create log directory
mkdir -p /var/log/coco
chown "${COCO_USER}:${COCO_USER}" /var/log/coco
log_info "Log directory created"

# Reload systemd and restart services
log_info "Reloading systemd daemon..."
systemctl daemon-reload

log_info "Enabling and restarting services..."
for svc in coco-agent-scheduler coco-heartbeat coco-command-poller coco-update; do
    if systemctl list-unit-files "${svc}.timer" &>/dev/null; then
        systemctl enable "${svc}.timer" 2>/dev/null || true
        systemctl restart "${svc}.timer" 2>/dev/null || true
        log_info "  ${svc}.timer enabled and started"
    fi
done

echo ""
echo "============================================"
echo -e "${GREEN}  Provisioning Complete!${NC}"
echo "============================================"
echo ""
echo "Device ID:      $DEVICE_ID"
echo "Participant ID: $PARTICIPANT_ID"
echo "Version:        $AGENT_VERSION"

# Show current network status
if command -v nmcli &>/dev/null; then
    WIFI_SSID=$(nmcli -t -f NAME,TYPE c show --active 2>/dev/null | grep wifi | cut -d: -f1)
    if [[ -n "$WIFI_SSID" ]]; then
        echo "WiFi Network:   $WIFI_SSID"
    fi
fi

echo ""
echo "WiFi Provisioning:"
echo "  If the device loses WiFi or is moved to a new location,"
echo "  it will automatically create a hotspot named 'CoCo-XXXX'."
echo "  Connect to configure new WiFi credentials."
echo ""
echo "Next steps:"
echo "  1. Test audio: speaker-test -D $AUDIO_OUT -c 1 -t sine -f 440 -l 1"
echo "  2. Test mic:   arecord -D $AUDIO_IN -d 3 -f S16_LE -r 24000 test.wav && aplay test.wav"
echo "  3. Run test:   npm start"
echo "  4. Check logs: tail -f /var/log/coco/agent.log"
echo ""
