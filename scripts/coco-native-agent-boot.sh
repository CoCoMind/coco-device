#!/usr/bin/env bash
set -euo pipefail

# Resolve repo dir and run user (defaults to the invoking sudo user or the current user)
RUN_USER="${COCO_RUN_USER:-${SUDO_USER:-${USER}}}"
REPO_DIR="${COCO_REPO_DIR:-/home/${RUN_USER}/coco-device}"
cd "$REPO_DIR"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

export COCO_AGENT_MODE="${COCO_AGENT_MODE:-mock}"
exec npm start
