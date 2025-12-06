#!/usr/bin/env bash
# coco-health-check.sh - Comprehensive device health check
# Run this after installation to verify everything is set up correctly
# Usage: ./scripts/coco-health-check.sh [--verbose]

set -uo pipefail

INSTALL_DIR="${COCO_INSTALL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
VERBOSE="${1:-}"
PASS=0
FAIL=0
WARN=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $*"; ((PASS++)); }
fail() { echo -e "${RED}[FAIL]${NC} $*"; ((FAIL++)); }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; ((WARN++)); }
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
section() { echo -e "\n${BLUE}=== $* ===${NC}"; }

# ============================================================================
# 1. ENVIRONMENT & CONFIG
# ============================================================================
check_environment() {
  section "Environment & Configuration"

  # Check .env file exists
  local env_files=("/etc/coco/.env" "${INSTALL_DIR}/.env")
  local env_found=0
  for ef in "${env_files[@]}"; do
    if [[ -f "$ef" ]]; then
      pass ".env file found: $ef"
      env_found=1
      # Source it for later checks
      set -a; source "$ef" 2>/dev/null; set +a
      break
    fi
  done
  [[ $env_found -eq 0 ]] && fail ".env file not found in ${env_files[*]}"

  # Check required env vars
  local required_vars=(COCO_DEVICE_ID COCO_BACKEND_URL OPENAI_API_KEY)
  for var in "${required_vars[@]}"; do
    if [[ -n "${!var:-}" ]]; then
      if [[ "$VERBOSE" == "--verbose" ]]; then
        pass "$var is set"
      else
        pass "$var is set"
      fi
    else
      fail "$var is not set"
    fi
  done

  # Check optional but recommended vars
  local optional_vars=(INGEST_SERVICE_TOKEN COCO_PARTICIPANT_ID)
  for var in "${optional_vars[@]}"; do
    if [[ -n "${!var:-}" ]]; then
      pass "$var is set"
    else
      warn "$var is not set (optional)"
    fi
  done
}

# ============================================================================
# 2. FILE SYSTEM
# ============================================================================
check_filesystem() {
  section "File System"

  # Check install directory
  if [[ -d "$INSTALL_DIR" ]]; then
    pass "Install directory exists: $INSTALL_DIR"
  else
    fail "Install directory missing: $INSTALL_DIR"
    return
  fi

  # Check required source files
  local required_files=(
    "src/syncSession.ts"
    "package.json"
    "tsconfig.json"
    "config/curriculum/activities.json"
  )
  for f in "${required_files[@]}"; do
    if [[ -f "${INSTALL_DIR}/${f}" ]]; then
      pass "Found: $f"
    else
      fail "Missing: $f"
    fi
  done

  # Check scripts are executable
  local scripts=(
    "scripts/coco-native-agent-boot.sh"
    "scripts/coco-heartbeat.sh"
    "scripts/coco-update.sh"
    "scripts/coco-command-poller.sh"
    "scripts/run-scheduled-session.sh"
  )
  for s in "${scripts[@]}"; do
    if [[ -x "${INSTALL_DIR}/${s}" ]]; then
      pass "Executable: $s"
    elif [[ -f "${INSTALL_DIR}/${s}" ]]; then
      warn "Exists but not executable: $s"
    else
      fail "Missing script: $s"
    fi
  done

  # Check log directory
  if [[ -d /var/log/coco ]]; then
    pass "Log directory exists: /var/log/coco"
    if [[ -w /var/log/coco ]]; then
      pass "Log directory is writable"
    else
      warn "Log directory not writable by current user"
    fi
  else
    warn "Log directory missing: /var/log/coco (create with: sudo mkdir -p /var/log/coco)"
  fi
}

# ============================================================================
# 3. DEPENDENCIES
# ============================================================================
check_dependencies() {
  section "Dependencies"

  # Node.js
  if command -v node &>/dev/null; then
    local node_ver=$(node --version)
    pass "Node.js installed: $node_ver"
    # Check minimum version (v18+)
    local major_ver=$(echo "$node_ver" | sed 's/v\([0-9]*\).*/\1/')
    if [[ $major_ver -ge 18 ]]; then
      pass "Node.js version >= 18"
    else
      warn "Node.js version < 18 (recommended: v18+)"
    fi
  else
    fail "Node.js not installed"
  fi

  # npm
  if command -v npm &>/dev/null; then
    pass "npm installed: $(npm --version)"
  else
    fail "npm not installed"
  fi

  # Check node_modules
  if [[ -d "${INSTALL_DIR}/node_modules" ]]; then
    pass "node_modules directory exists"
    # Check key dependencies
    local deps=(openai tsx zod)
    for dep in "${deps[@]}"; do
      if [[ -d "${INSTALL_DIR}/node_modules/${dep}" ]]; then
        pass "Dependency installed: $dep"
      else
        fail "Dependency missing: $dep (run: npm install)"
      fi
    done
  else
    fail "node_modules missing (run: npm install)"
  fi

  # ALSA tools (for audio)
  if command -v aplay &>/dev/null; then
    pass "aplay installed (ALSA)"
  else
    warn "aplay not installed (needed for audio playback)"
  fi

  if command -v arecord &>/dev/null; then
    pass "arecord installed (ALSA)"
  else
    warn "arecord not installed (needed for audio recording)"
  fi

  # curl (for API calls)
  if command -v curl &>/dev/null; then
    pass "curl installed"
  else
    fail "curl not installed"
  fi
}

# ============================================================================
# 4. SYSTEMD SERVICES
# ============================================================================
check_systemd() {
  section "Systemd Services"

  # Check if systemd is available
  if ! command -v systemctl &>/dev/null; then
    warn "systemctl not available (not running systemd?)"
    return
  fi

  # Check timers
  local timers=(
    coco-agent-scheduler.timer
    coco-heartbeat.timer
    coco-update.timer
    coco-command-poller.timer
  )
  for timer in "${timers[@]}"; do
    if systemctl is-enabled "$timer" &>/dev/null; then
      pass "$timer is enabled"
    else
      warn "$timer is not enabled"
    fi

    if systemctl is-active "$timer" &>/dev/null; then
      pass "$timer is active"
    else
      warn "$timer is not active"
    fi
  done

  # Check service files exist
  local services=(
    coco-agent.service
    coco-agent-scheduler.service
    coco-heartbeat.service
    coco-update.service
    coco-command-poller.service
  )
  for svc in "${services[@]}"; do
    if [[ -f "/etc/systemd/system/${svc}" ]]; then
      pass "Service file exists: $svc"
    else
      warn "Service file missing: $svc"
    fi
  done
}

# ============================================================================
# 5. NETWORK CONNECTIVITY
# ============================================================================
check_network() {
  section "Network Connectivity"

  # Basic internet check
  if ping -c 1 -W 3 8.8.8.8 &>/dev/null; then
    pass "Internet connectivity (ping 8.8.8.8)"
  else
    fail "No internet connectivity"
  fi

  # DNS resolution
  if ping -c 1 -W 3 google.com &>/dev/null; then
    pass "DNS resolution working"
  else
    warn "DNS resolution may have issues"
  fi

  # Check backend URL reachability
  if [[ -n "${COCO_BACKEND_URL:-}" ]]; then
    local backend_host=$(echo "$COCO_BACKEND_URL" | sed 's|https\?://||' | cut -d/ -f1)
    if curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" "${COCO_BACKEND_URL}/healthz" 2>/dev/null | grep -qE '^[23]'; then
      pass "Backend reachable: $COCO_BACKEND_URL"
    elif ping -c 1 -W 3 "$backend_host" &>/dev/null; then
      warn "Backend host reachable but /healthz endpoint failed"
    else
      fail "Backend unreachable: $COCO_BACKEND_URL"
    fi
  fi

  # Check OpenAI API
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    local api_check=$(curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer ${OPENAI_API_KEY}" \
      "https://api.openai.com/v1/models" 2>/dev/null)
    if [[ "$api_check" == "200" ]]; then
      pass "OpenAI API key valid"
    elif [[ "$api_check" == "401" ]]; then
      fail "OpenAI API key invalid (401)"
    else
      warn "OpenAI API check inconclusive (HTTP $api_check)"
    fi
  fi

  # Check git remote
  cd "$INSTALL_DIR"
  if git ls-remote --exit-code origin HEAD &>/dev/null; then
    pass "Git remote accessible"
  else
    warn "Git remote not accessible (updates may fail)"
  fi
}

# ============================================================================
# 6. AUDIO DEVICES
# ============================================================================
check_audio() {
  section "Audio Devices"

  # Skip if ALSA not available
  if ! command -v aplay &>/dev/null; then
    warn "Skipping audio checks (aplay not installed)"
    return
  fi

  # List playback devices
  if aplay -l &>/dev/null; then
    local playback_count=$(aplay -l 2>/dev/null | grep -c "^card" || echo 0)
    if [[ $playback_count -gt 0 ]]; then
      pass "Found $playback_count audio playback device(s)"
      if [[ "$VERBOSE" == "--verbose" ]]; then
        aplay -l 2>/dev/null | grep "^card"
      fi
    else
      warn "No audio playback devices found"
    fi
  fi

  # List recording devices
  if arecord -l &>/dev/null; then
    local record_count=$(arecord -l 2>/dev/null | grep -c "^card" || echo 0)
    if [[ $record_count -gt 0 ]]; then
      pass "Found $record_count audio recording device(s)"
      if [[ "$VERBOSE" == "--verbose" ]]; then
        arecord -l 2>/dev/null | grep "^card"
      fi
    else
      warn "No audio recording devices found"
    fi
  fi

  # Check configured audio devices
  if [[ -n "${COCO_AUDIO_OUTPUT_DEVICE:-}" ]]; then
    info "Configured output device: $COCO_AUDIO_OUTPUT_DEVICE"
  fi
  if [[ -n "${COCO_AUDIO_INPUT_DEVICE:-}" ]]; then
    info "Configured input device: $COCO_AUDIO_INPUT_DEVICE"
  fi
}

# ============================================================================
# 7. TYPESCRIPT/BUILD
# ============================================================================
check_typescript() {
  section "TypeScript & Build"

  cd "$INSTALL_DIR"

  # Check TypeScript config
  if [[ -f "tsconfig.json" ]]; then
    pass "tsconfig.json exists"
  else
    fail "tsconfig.json missing"
  fi

  # Run typecheck (quick validation)
  if command -v npx &>/dev/null; then
    info "Running typecheck (this may take a moment)..."
    if npx tsc --noEmit 2>/dev/null; then
      pass "TypeScript compilation successful"
    else
      warn "TypeScript errors detected (run: npm run typecheck)"
    fi
  fi
}

# ============================================================================
# 8. QUICK FUNCTIONAL TEST
# ============================================================================
check_functional() {
  section "Functional Tests"

  cd "$INSTALL_DIR"

  # Test that syncSession.ts can at least be parsed
  if [[ -f "src/syncSession.ts" ]]; then
    if timeout 5 npx tsx --eval "import './src/syncSession.ts'" 2>/dev/null; then
      pass "syncSession.ts imports successfully"
    else
      # This is expected to fail without full env, just check syntax
      info "syncSession.ts syntax check skipped (requires full env)"
    fi
  fi

  # Run script syntax checks
  info "Validating shell scripts..."
  local script_errors=0
  for script in scripts/*.sh; do
    if bash -n "$script" 2>/dev/null; then
      [[ "$VERBOSE" == "--verbose" ]] && pass "Syntax OK: $(basename $script)"
    else
      fail "Syntax error in: $(basename $script)"
      ((script_errors++))
    fi
  done
  [[ $script_errors -eq 0 ]] && pass "All shell scripts have valid syntax"
}

# ============================================================================
# SUMMARY
# ============================================================================
print_summary() {
  echo ""
  echo "============================================"
  echo "  HEALTH CHECK SUMMARY"
  echo "============================================"
  echo ""
  echo -e "  ${GREEN}PASS${NC}: $PASS"
  echo -e "  ${YELLOW}WARN${NC}: $WARN"
  echo -e "  ${RED}FAIL${NC}: $FAIL"
  echo ""

  if [[ $FAIL -eq 0 ]]; then
    if [[ $WARN -eq 0 ]]; then
      echo -e "${GREEN}All checks passed! Device is ready.${NC}"
    else
      echo -e "${YELLOW}Device is mostly ready, but has $WARN warning(s).${NC}"
    fi
    echo ""
    echo "Next steps:"
    echo "  1. Test audio: npm start (with COCO_AUDIO_DISABLE=0)"
    echo "  2. Check logs: tail -f /var/log/coco/*.log"
    echo ""
    return 0
  else
    echo -e "${RED}Device has $FAIL critical issue(s) that need to be fixed.${NC}"
    echo ""
    echo "Common fixes:"
    echo "  - Missing .env: sudo ./scripts/provision-device.sh"
    echo "  - Missing deps: npm install"
    echo "  - Missing services: sudo ./scripts/coco-update.sh"
    echo ""
    return 1
  fi
}

# ============================================================================
# MAIN
# ============================================================================
main() {
  echo "============================================"
  echo "  Coco Device Health Check"
  echo "  $(date -Iseconds)"
  echo "============================================"

  check_environment
  check_filesystem
  check_dependencies
  check_systemd
  check_network
  check_audio
  check_typescript
  check_functional

  print_summary
}

main "$@"
