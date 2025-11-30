#!/usr/bin/env bash
set -euo pipefail

RUN_USER="${COCO_RUN_USER:-${SUDO_USER:-${USER:-pi}}}"
RUN_HOME="${RUN_HOME:-$(getent passwd "$RUN_USER" | cut -d: -f6 || echo "/home/${RUN_USER}")}"
INSTALL_DIR="${INSTALL_DIR:-${RUN_HOME}/coco-device}"
BRANCH="${BRANCH:-latest-tag}"

log() {
  local ts
  ts=$(date -Iseconds)
  echo "${ts} [coco-update] $*"
}

install_bins() {
  log "Updating launcher scripts in /usr/local/bin"
  install -m 755 "${INSTALL_DIR}/scripts/coco-native-agent-boot.sh" /usr/local/bin/coco-native-agent-boot.sh
  install -m 755 "${INSTALL_DIR}/scripts/run-scheduled-session.sh" /usr/local/bin/run-scheduled-session.sh
  install -m 755 "${INSTALL_DIR}/scripts/coco-heartbeat.sh" /usr/local/bin/coco-heartbeat.sh
  install -m 755 "${INSTALL_DIR}/scripts/coco-update.sh" /usr/local/bin/coco-update.sh
  install -m 755 "${INSTALL_DIR}/scripts/coco-command-poller.sh" /usr/local/bin/coco-command-poller.sh
}

install_units() {
  log "Refreshing systemd units"
  install -m 644 "${INSTALL_DIR}/systemd/coco-agent.service" /etc/systemd/system/coco-agent.service
  install -m 644 "${INSTALL_DIR}/systemd/coco-agent-scheduler.service" /etc/systemd/system/coco-agent-scheduler.service
  install -m 644 "${INSTALL_DIR}/systemd/coco-agent-scheduler.timer" /etc/systemd/system/coco-agent-scheduler.timer
  install -m 644 "${INSTALL_DIR}/systemd/coco-heartbeat.service" /etc/systemd/system/coco-heartbeat.service
  install -m 644 "${INSTALL_DIR}/systemd/coco-heartbeat.timer" /etc/systemd/system/coco-heartbeat.timer
  install -m 644 "${INSTALL_DIR}/systemd/coco-update.service" /etc/systemd/system/coco-update.service
  install -m 644 "${INSTALL_DIR}/systemd/coco-update.timer" /etc/systemd/system/coco-update.timer
  install -m 644 "${INSTALL_DIR}/systemd/coco-command-poller.service" /etc/systemd/system/coco-command-poller.service
  install -m 644 "${INSTALL_DIR}/systemd/coco-command-poller.timer" /etc/systemd/system/coco-command-poller.timer

  # Update User= in all services
  sed -i "s/^User=.*/User=${RUN_USER}/" \
    /etc/systemd/system/coco-agent.service \
    /etc/systemd/system/coco-agent-scheduler.service \
    /etc/systemd/system/coco-heartbeat.service \
    /etc/systemd/system/coco-command-poller.service || true
  # Update Group= in services that have it
  sed -i "s/^Group=.*/Group=${RUN_USER}/" \
    /etc/systemd/system/coco-heartbeat.service \
    /etc/systemd/system/coco-command-poller.service || true
  # Update WorkingDirectory= paths
  sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
    /etc/systemd/system/coco-agent.service \
    /etc/systemd/system/coco-agent-scheduler.service \
    /etc/systemd/system/coco-update.service || true
  # Update COCO_RUN_USER environment variable
  sed -i "s/^Environment=COCO_RUN_USER=.*/Environment=COCO_RUN_USER=${RUN_USER}/" \
    /etc/systemd/system/coco-update.service \
    /etc/systemd/system/coco-agent-scheduler.service || true

  systemctl daemon-reload
  systemctl enable coco-agent-scheduler.timer coco-heartbeat.timer coco-update.timer coco-command-poller.timer
}

cd "$INSTALL_DIR"
target_ref="${BRANCH}"
if [[ "${BRANCH}" == "latest-tag" ]]; then
  # Run git as the user who owns the repo (has SSH keys)
  target_ref="$(sudo -u "$RUN_USER" git ls-remote --tags --sort=v:refname origin | tail -n1 | sed 's#.*/##')"
  target_ref="${target_ref:-main}"
  log "Resolved latest tag to ${target_ref}"
fi
log "Fetching latest ${target_ref}"
sudo -u "$RUN_USER" git fetch --all --tags
sudo -u "$RUN_USER" git reset --hard "origin/${target_ref}" || sudo -u "$RUN_USER" git reset --hard "${target_ref}"
install_bins
install_units
log "Installing npm dependencies"
sudo -u "$RUN_USER" npm install
if command -v node >/dev/null 2>&1 && [[ -f "${INSTALL_DIR}/package.json" ]]; then
  version=$(cd "${INSTALL_DIR}" && node -p "require('./package.json').version" 2>/dev/null || true)
  if [[ -n "${version:-}" ]]; then
    echo -n "$version" >/etc/coco-agent-version
    log "Updated /etc/coco-agent-version to ${version}"
  fi
fi
log "Restarting services"
systemctl restart coco-agent.service
systemctl restart coco-agent-scheduler.timer
systemctl restart coco-heartbeat.timer
systemctl restart coco-update.timer
systemctl restart coco-command-poller.timer
log "Update complete"
