#!/usr/bin/env bash
set -euo pipefail

RUN_USER="${COCO_RUN_USER:-${SUDO_USER:-${USER:-pi}}}"
RUN_HOME="${RUN_HOME:-$(getent passwd "$RUN_USER" | cut -d: -f6 || echo "/home/${RUN_USER}")}"
INSTALL_DIR="${INSTALL_DIR:-${RUN_HOME}/coco-device}"
BRANCH="${BRANCH:-latest-tag}"

log() { echo "[update] $*"; }

cd "$INSTALL_DIR"
target_ref="${BRANCH}"
if [[ "${BRANCH}" == "latest-tag" ]]; then
  target_ref="$(git ls-remote --tags --sort=v:refname origin | tail -n1 | sed 's#.*/##')"
  target_ref="${target_ref:-main}"
  log "Resolved latest tag to ${target_ref}"
fi
log "Fetching latest ${target_ref}"
sudo -u "$RUN_USER" git fetch --all --tags
sudo -u "$RUN_USER" git reset --hard "origin/${target_ref}" || sudo -u "$RUN_USER" git reset --hard "${target_ref}"
log "Installing npm dependencies"
sudo -u "$RUN_USER" npm install
log "Restarting services"
systemctl restart coco-agent.service
systemctl restart coco-agent-scheduler.timer
log "Update complete"
