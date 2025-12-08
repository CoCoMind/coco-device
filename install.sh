#!/usr/bin/env bash
set -euo pipefail

# Coco Device Bootstrap Installer
# Run: curl -sSL https://raw.githubusercontent.com/jh2k2/coco-hardware-scripts/main/install.sh | sudo bash

REPO_URL="${REPO_URL:-https://github.com/jh2k2/coco-hardware-scripts.git}"
BRANCH="${BRANCH:-main}"
RUN_USER="${SUDO_USER:-${USER:-pi}}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6 || echo "/home/${RUN_USER}")"
INSTALL_DIR="${INSTALL_DIR:-${RUN_HOME}/coco-device}"

log() { echo "[install] $*"; }
err() { echo "[install] ERROR: $*" >&2; exit 1; }

# Check if running as root
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (use sudo)"
fi

# Warn if RUN_USER is root (likely ran from root shell instead of sudo)
if [[ "$RUN_USER" == "root" ]]; then
  log "WARNING: Installing as root user. This may cause permission issues."
  log "         If this is unintended, run: sudo ./install.sh (not from a root shell)"
  log "         Or set RUN_USER explicitly: sudo RUN_USER=pi ./install.sh"
  sleep 3
fi

log "Installing Coco Device for user: ${RUN_USER}"
log "Install directory: ${INSTALL_DIR}"

# Install system dependencies
log "Installing system dependencies..."
apt-get update
apt-get install -y curl git alsa-utils build-essential network-manager

# Switch from dhcpcd to NetworkManager (required for Comitup WiFi provisioning)
if systemctl is-active --quiet dhcpcd 2>/dev/null; then
  log "Switching from dhcpcd to NetworkManager..."
  systemctl stop dhcpcd || true
  systemctl disable dhcpcd || true
  systemctl enable NetworkManager
  systemctl start NetworkManager
fi

# Install Comitup for WiFi provisioning (captive portal)
log "Installing Comitup WiFi provisioning..."
if ! command -v comitup &>/dev/null; then
  # Download and install the apt-source package (sets up repo correctly)
  COMITUP_APT_DEB="/tmp/comitup-apt-source.deb"
  curl -fsSL -o "$COMITUP_APT_DEB" "https://davesteele.github.io/comitup/deb/davesteele-comitup-apt-source_1.3_all.deb"
  dpkg -i "$COMITUP_APT_DEB"
  rm -f "$COMITUP_APT_DEB"
  apt-get update
  apt-get install -y comitup comitup-watch
else
  log "Comitup already installed"
fi

# Install Node.js 20 if not present or wrong version
if ! command -v node &>/dev/null || [[ "$(node -v 2>/dev/null | cut -d. -f1)" != "v20" ]]; then
  log "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  log "Node.js 20 already installed: $(node -v)"
fi

# Create required directories
log "Creating directories..."
mkdir -p /var/log/coco /var/lib/coco
chown "${RUN_USER}:${RUN_USER}" /var/log/coco /var/lib/coco

# Clone or update repository
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  log "Repository exists, pulling latest..."
  cd "${INSTALL_DIR}"
  sudo -u "$RUN_USER" git fetch --all
  sudo -u "$RUN_USER" git reset --hard "origin/${BRANCH}"
else
  log "Cloning repository..."
  sudo -u "$RUN_USER" git clone -b "${BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
fi

# Install npm dependencies
log "Installing npm dependencies..."
sudo -u "$RUN_USER" npm install

# Install launcher scripts
log "Installing launcher scripts to /usr/local/bin..."
install -m 755 "${INSTALL_DIR}/scripts/coco-native-agent-boot.sh" /usr/local/bin/coco-native-agent-boot.sh
install -m 755 "${INSTALL_DIR}/scripts/run-scheduled-session.sh" /usr/local/bin/run-scheduled-session.sh
install -m 755 "${INSTALL_DIR}/scripts/coco-heartbeat.sh" /usr/local/bin/coco-heartbeat.sh
install -m 755 "${INSTALL_DIR}/scripts/coco-update.sh" /usr/local/bin/coco-update.sh
install -m 755 "${INSTALL_DIR}/scripts/coco-command-poller.sh" /usr/local/bin/coco-command-poller.sh

# Install systemd units
log "Installing systemd units..."
install -m 644 "${INSTALL_DIR}/systemd/coco-agent.service" /etc/systemd/system/coco-agent.service
install -m 644 "${INSTALL_DIR}/systemd/coco-agent-scheduler.service" /etc/systemd/system/coco-agent-scheduler.service
install -m 644 "${INSTALL_DIR}/systemd/coco-agent-scheduler.timer" /etc/systemd/system/coco-agent-scheduler.timer
install -m 644 "${INSTALL_DIR}/systemd/coco-heartbeat.service" /etc/systemd/system/coco-heartbeat.service
install -m 644 "${INSTALL_DIR}/systemd/coco-heartbeat.timer" /etc/systemd/system/coco-heartbeat.timer
install -m 644 "${INSTALL_DIR}/systemd/coco-update.service" /etc/systemd/system/coco-update.service
install -m 644 "${INSTALL_DIR}/systemd/coco-update.timer" /etc/systemd/system/coco-update.timer
install -m 644 "${INSTALL_DIR}/systemd/coco-command-poller.service" /etc/systemd/system/coco-command-poller.service
install -m 644 "${INSTALL_DIR}/systemd/coco-command-poller.timer" /etc/systemd/system/coco-command-poller.timer

# Update user in service files
log "Configuring services for user ${RUN_USER}..."
sed -i "s/^User=.*/User=${RUN_USER}/" \
  /etc/systemd/system/coco-agent.service \
  /etc/systemd/system/coco-agent-scheduler.service \
  /etc/systemd/system/coco-heartbeat.service \
  /etc/systemd/system/coco-command-poller.service || true
sed -i "s/^Group=.*/Group=${RUN_USER}/" \
  /etc/systemd/system/coco-heartbeat.service \
  /etc/systemd/system/coco-command-poller.service || true
sed -i "s/^Environment=COCO_RUN_USER=.*/Environment=COCO_RUN_USER=${RUN_USER}/" \
  /etc/systemd/system/coco-update.service || true
sed -i "s|WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
  /etc/systemd/system/coco-agent.service \
  /etc/systemd/system/coco-agent-scheduler.service || true

systemctl daemon-reload

# Store version
if [[ -f "${INSTALL_DIR}/package.json" ]]; then
  version=$(cd "${INSTALL_DIR}" && node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
  echo -n "$version" >/etc/coco-agent-version
  log "Installed version: ${version}"
fi

# Configure Comitup with CoCo branding
log "Configuring Comitup WiFi provisioning..."
if [[ -f "${INSTALL_DIR}/config/comitup.conf" ]]; then
  cp "${INSTALL_DIR}/config/comitup.conf" /etc/comitup.conf
  log "Comitup configuration installed"
fi
systemctl enable comitup || true

log ""
log "============================================"
log "Installation complete!"
log "============================================"
log ""
log "WiFi Setup:"
log "  If no WiFi is configured, the device will create a hotspot:"
log "    SSID: CoCo-XXXX (where XXXX is a unique identifier)"
log "  Connect to this hotspot and a captive portal will appear"
log "  to configure the WiFi network."
log ""
log "Next steps:"
log "  1. Configure environment:"
log "     cd ${INSTALL_DIR}"
log "     sudo ./scripts/provision-device.sh"
log ""
log "  2. Enable and start services:"
log "     sudo systemctl enable --now coco-agent-scheduler.timer coco-heartbeat.timer coco-update.timer coco-command-poller.timer"
log ""
log "  3. View logs:"
log "     tail -f /var/log/coco/agent.log"
log ""
