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

log "Installing Coco Device for user: ${RUN_USER}"
log "Install directory: ${INSTALL_DIR}"

# Install system dependencies
log "Installing system dependencies..."
apt-get update
apt-get install -y curl git alsa-utils build-essential

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

log ""
log "============================================"
log "Installation complete!"
log "============================================"
log ""
log "Next steps:"
log "  1. Configure environment:"
log "     cd ${INSTALL_DIR}"
log "     cp .env.example .env"
log "     nano .env"
log ""
log "  2. Enable and start services:"
log "     sudo systemctl enable --now coco-agent-scheduler.timer coco-heartbeat.timer coco-update.timer coco-command-poller.timer"
log ""
log "  3. View logs:"
log "     tail -f /var/log/coco/agent.log"
log ""
