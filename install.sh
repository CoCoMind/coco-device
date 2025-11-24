#!/usr/bin/env bash
set -euo pipefail

# Coco device bootstrap installer

REPO_URL="${REPO_URL:-https://github.com/jh2k2/coco-hardware-scripts.git}"
# Use BRANCH=latest-tag to pull the newest tag; otherwise use specified branch/tag.
BRANCH="${BRANCH:-latest-tag}"
RUN_USER="${COCO_RUN_USER:-${SUDO_USER:-${USER:-pi}}}"
RUN_HOME="${RUN_HOME:-$(getent passwd "$RUN_USER" | cut -d: -f6 || echo "/home/${RUN_USER}")}"
INSTALL_DIR="${INSTALL_DIR:-${RUN_HOME}/coco-device}"
LOCAL_MODE=false
if [[ "${1:-}" == "--local" ]]; then
  LOCAL_MODE=true
fi

log() {
  echo "[install] $*"
}

apt_install() {
  log "Installing system dependencies (curl, git, alsa-utils, build-essential, nodejs 20)..."
  apt-get update -y
  apt-get install -y curl git alsa-utils build-essential ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

clone_repo() {
  if $LOCAL_MODE; then
    log "Local mode: skipping clone (using existing directory)."
    return
  fi
  local target_ref="${BRANCH}"
  if [[ "${BRANCH}" == "latest-tag" ]]; then
    target_ref="$(git ls-remote --tags --sort=v:refname "${REPO_URL}" | tail -n1 | sed 's#.*/##')"
    target_ref="${target_ref:-main}"
    log "Resolved latest tag to ${target_ref}"
  fi
  log "Cloning ${REPO_URL} (ref ${target_ref}) to ${INSTALL_DIR}"
  rm -rf "${INSTALL_DIR}"
  git clone --depth 1 --branch "${target_ref}" "${REPO_URL}" "${INSTALL_DIR}"
  chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}"
}

install_scripts() {
  log "Installing scripts to /usr/local/bin"
  install -m 755 "${INSTALL_DIR}/scripts/coco-native-agent-boot.sh" /usr/local/bin/coco-native-agent-boot.sh
  install -m 755 "${INSTALL_DIR}/scripts/run-scheduled-session.sh" /usr/local/bin/run-scheduled-session.sh
  install -m 755 "${INSTALL_DIR}/scripts/wifi-provision.sh" /usr/local/bin/wifi-provision.sh
  install -m 755 "${INSTALL_DIR}/scripts/coco-heartbeat.sh" /usr/local/bin/coco-heartbeat.sh
  if [[ -f "${INSTALL_DIR}/scripts/coco-update.sh" ]]; then
    install -m 755 "${INSTALL_DIR}/scripts/coco-update.sh" /usr/local/bin/coco-update.sh
  fi
}

install_units() {
  log "Installing systemd units"
  install -m 644 "${INSTALL_DIR}/systemd/coco-agent.service" /etc/systemd/system/coco-agent.service
  install -m 644 "${INSTALL_DIR}/systemd/coco-agent-scheduler.service" /etc/systemd/system/coco-agent-scheduler.service
  install -m 644 "${INSTALL_DIR}/systemd/coco-agent-scheduler.timer" /etc/systemd/system/coco-agent-scheduler.timer
  install -m 644 "${INSTALL_DIR}/systemd/coco-heartbeat.service" /etc/systemd/system/coco-heartbeat.service
  install -m 644 "${INSTALL_DIR}/systemd/coco-heartbeat.timer" /etc/systemd/system/coco-heartbeat.timer
  install -m 644 "${INSTALL_DIR}/systemd/wifi-provision.service" /etc/systemd/system/wifi-provision.service
  sed -i "s/^User=.*/User=${RUN_USER}/" /etc/systemd/system/coco-agent.service /etc/systemd/system/coco-agent-scheduler.service /etc/systemd/system/coco-heartbeat.service
  sed -i "s/^Group=.*/Group=${RUN_USER}/" /etc/systemd/system/coco-heartbeat.service || true
  systemctl daemon-reload
  systemctl enable coco-agent.service coco-agent-scheduler.timer coco-heartbeat.timer wifi-provision.service
}

prepare_dirs() {
  log "Creating data/log directories"
  mkdir -p /var/lib/coco
  mkdir -p /var/log/coco
  chown -R "${RUN_USER}:${RUN_USER}" /var/lib/coco /var/log/coco || true
}

install_node_modules() {
  log "Installing npm dependencies"
  sudo -u "${RUN_USER}" bash -c "cd '${INSTALL_DIR}' && npm install"
}

main() {
  apt_install
  clone_repo
  install_scripts
  install_units
  prepare_dirs
  install_node_modules
  log "DONE – add your .env at ${INSTALL_DIR}/.env (see .env.example)."
}

main "$@"
