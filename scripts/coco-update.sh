#!/usr/bin/env bash
set -euo pipefail

RUN_USER="${COCO_RUN_USER:-${SUDO_USER:-${USER:-pi}}}"
RUN_HOME="${RUN_HOME:-$(getent passwd "$RUN_USER" | cut -d: -f6 || echo "/home/${RUN_USER}")}"
INSTALL_DIR="${INSTALL_DIR:-${RUN_HOME}/coco-device}"
BRANCH="${BRANCH:-latest-tag}"
LOG_FILE="${COCO_UPDATE_LOG_FILE:-/var/log/coco/update.log}"
ROLLBACK_FILE="${INSTALL_DIR}/.rollback-commit"

ensure_log_file() {
  mkdir -p "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
  chmod 644 "$LOG_FILE"
}

log() {
  local ts
  ts=$(date -Iseconds)
  echo "${ts} [coco-update] $*" | tee -a "$LOG_FILE"
}

die() {
  log "ERROR: $*"
  exit 1
}

get_latest_tag() {
  # Get latest tag, filtering out annotated tag dereferenced entries (^{})
  # and extracting just the tag name. Returns empty if no tags exist.
  sudo -u "$RUN_USER" git ls-remote --tags --sort=v:refname origin 2>/dev/null \
    | grep -v '\^{}' \
    | tail -n1 \
    | sed 's#.*/##' \
    || true
}

validate_ref() {
  local ref="$1"
  # Check if ref exists as a branch or tag on origin
  if sudo -u "$RUN_USER" git ls-remote --exit-code origin "refs/heads/${ref}" >/dev/null 2>&1; then
    return 0
  fi
  if sudo -u "$RUN_USER" git ls-remote --exit-code origin "refs/tags/${ref}" >/dev/null 2>&1; then
    return 0
  fi
  return 1
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

# Health check: verify the code can at least be parsed by Node
health_check() {
  log "Running health check..."

  # Check 1: Verify main entry point exists
  if [[ ! -f "${INSTALL_DIR}/src/syncSession.ts" ]]; then
    log "Health check FAILED: src/syncSession.ts not found"
    return 1
  fi

  # Check 2: Verify package.json exists and is valid JSON
  if ! node -e "require('${INSTALL_DIR}/package.json')" 2>/dev/null; then
    log "Health check FAILED: package.json invalid"
    return 1
  fi

  # Check 3: Verify node_modules exist (npm install succeeded)
  if [[ ! -d "${INSTALL_DIR}/node_modules" ]]; then
    log "Health check FAILED: node_modules not found"
    return 1
  fi

  # Check 4: Quick syntax check on main files (tsx can parse them)
  if ! sudo -u "$RUN_USER" node -e "require('${INSTALL_DIR}/node_modules/typescript')" 2>/dev/null; then
    log "Health check WARN: TypeScript not available, skipping syntax check"
  else
    if ! sudo -u "$RUN_USER" npx tsc --noEmit --skipLibCheck 2>/dev/null; then
      log "Health check FAILED: TypeScript compilation errors"
      return 1
    fi
  fi

  log "Health check PASSED"
  return 0
}

# Rollback to previous commit
rollback() {
  local prev_commit="$1"
  log "ROLLBACK: Reverting to previous commit ${prev_commit}"

  if ! sudo -u "$RUN_USER" git reset --hard "${prev_commit}"; then
    log "ROLLBACK FAILED: Could not reset to ${prev_commit}"
    return 1
  fi

  log "ROLLBACK: Running npm install for previous version"
  sudo -u "$RUN_USER" npm install --omit=dev 2>&1 || true

  log "ROLLBACK: Restoring previous bins and units"
  install_bins
  install_units

  log "ROLLBACK COMPLETE: Reverted to ${prev_commit}"
  return 0
}

ensure_log_file
cd "$INSTALL_DIR" || die "Cannot cd to ${INSTALL_DIR}"

# Save current commit for potential rollback
PREV_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log "Current commit: ${PREV_COMMIT}"

# Save rollback point
echo "${PREV_COMMIT}" > "${ROLLBACK_FILE}"

target_ref="${BRANCH}"
if [[ "${BRANCH}" == "latest-tag" ]]; then
  target_ref="$(get_latest_tag)"
  target_ref="${target_ref:-main}"
  log "Resolved latest tag to ${target_ref}"
fi

# Validate target ref exists before proceeding
if ! validate_ref "$target_ref"; then
  die "Target ref '${target_ref}' not found on origin"
fi

log "Fetching latest ${target_ref}"
if ! sudo -u "$RUN_USER" git fetch --all --tags --force; then
  die "git fetch failed"
fi

# Try reset to origin/branch first, then bare ref (for tags)
if ! sudo -u "$RUN_USER" git reset --hard "origin/${target_ref}" 2>/dev/null; then
  if ! sudo -u "$RUN_USER" git reset --hard "${target_ref}"; then
    die "git reset failed for ref '${target_ref}'"
  fi
fi

NEW_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log "Updated to commit: ${NEW_COMMIT}"

# Check if we actually updated
if [[ "${PREV_COMMIT}" == "${NEW_COMMIT}" ]]; then
  log "Already at latest version, no update needed"
  rm -f "${ROLLBACK_FILE}"
  exit 0
fi

install_bins
install_units

log "Installing npm dependencies"
if ! sudo -u "$RUN_USER" npm install --omit=dev 2>&1; then
  log "WARN: npm install failed, attempting rollback"
  if rollback "${PREV_COMMIT}"; then
    die "Update failed (npm install), rolled back to ${PREV_COMMIT}"
  else
    die "Update failed and rollback failed - manual intervention required"
  fi
fi

# Run health check
if ! health_check; then
  log "Health check failed, attempting rollback"
  if rollback "${PREV_COMMIT}"; then
    die "Update failed (health check), rolled back to ${PREV_COMMIT}"
  else
    die "Update failed and rollback failed - manual intervention required"
  fi
fi

# Update version file
if command -v node >/dev/null 2>&1 && [[ -f "${INSTALL_DIR}/package.json" ]]; then
  version=$(cd "${INSTALL_DIR}" && node -p "require('./package.json').version" 2>/dev/null || true)
  if [[ -n "${version:-}" ]]; then
    echo -n "$version" >/etc/coco-agent-version
    log "Updated /etc/coco-agent-version to ${version}"
  fi
fi

log "Restarting services"
restart_failed=0
for svc in coco-agent-scheduler.timer coco-heartbeat.timer coco-update.timer coco-command-poller.timer; do
  if ! systemctl restart "$svc" 2>/dev/null; then
    log "WARN: Failed to restart $svc"
    restart_failed=1
  fi
done

# Clean up rollback file on success
rm -f "${ROLLBACK_FILE}"

if [[ $restart_failed -eq 1 ]]; then
  log "Update complete with warnings (some services failed to restart)"
else
  log "Update complete: ${PREV_COMMIT} -> ${NEW_COMMIT}"
fi
