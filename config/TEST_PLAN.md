# Coco Device Test Plan

## Overview

This test plan covers validation of the Coco cognitive coaching device software across:
- **Unit tests** - TypeScript/Node.js component testing
- **Integration tests** - Systemd services, backend communication
- **Manual tests** - Audio I/O, real-time sessions

---

## Quick Start

```bash
cd ~/coco-device

# Run all automated tests
npm test

# Run individual test suites
npm run test:agent     # Agent logic tests (45 tests)
npm run test:backend   # Backend API tests (9 tests)
npm run test:planner   # Activity planner tests (14 tests)

# Type checking only
npm run typecheck
```

---

## Test Suites

### 1. Agent Tests (`tests/agent.test.ts`)

**Coverage:** 45 tests

| Category | Tests | Description |
|----------|-------|-------------|
| ResponseTracker | 11 | Async response coordination, timeout handling |
| parseSentimentJson | 15 | JSON parsing, code fence stripping, validation |
| extractTextFromMessage | 11 | Message content extraction from various formats |
| clampParticipantWindow | 8 | Duration clamping within min/max bounds |

**Key scenarios:**
- Response tracking with multiple concurrent responses
- Deduplication of tracked response IDs
- Event handling (done, failed, cancelled, error)
- Sentiment JSON with markdown code fences
- Score clamping to 0-1 range
- Null/undefined/malformed input handling

### 2. Backend Tests (`tests/backend.test.ts`)

**Coverage:** 9 tests

| Category | Tests | Description |
|----------|-------|-------------|
| createSessionIdentifiers | 5 | UUID generation, uniqueness |
| Payload Types | 2 | TypeScript type validation |
| Integration | 2 | Live backend communication (if configured) |

**Key scenarios:**
- Valid UUID generation (RFC 4122 format)
- No ID collisions across 1000+ generations
- Correct payload structure for session summaries

### 3. Planner Tests (`tests/planner.test.ts`)

**Coverage:** 14 tests

| Category | Tests | Description |
|----------|-------|-------------|
| buildPlan | 9 | Plan generation, category ordering |
| Activity Structure | 3 | Field validation, type checking |
| Edge Cases | 2 | Stress testing, consistency |

**Key scenarios:**
- Exactly 6 activities per plan
- Correct category order (orientation → closing)
- Duration clamping between 1-2 minutes
- No duplicate activity IDs in single plan
- Randomization across multiple plan generations

---

## Integration Tests

### Systemd Services

```bash
# Check all timers are active
systemctl list-timers 'coco-*'

# Expected output:
# coco-agent-scheduler.timer - enabled/active (09:00, 15:00)
# coco-heartbeat.timer       - enabled/active (every 5 min)
# coco-update.timer          - enabled/active (daily 02:30)

# Verify agent service (should be inactive by default)
systemctl status coco-agent.service

# Test manual agent start
sudo systemctl start coco-agent.service
sudo tail -f /var/log/coco/agent.log
```

### Concurrency Lock

```bash
# Start a session with sleep to hold the lock
SESSION_CMD="sleep 30" ./scripts/run-scheduled-session.sh &
sleep 2

# Try starting agent service (should be blocked)
sudo systemctl start coco-agent.service
# Check logs for "already running" message
grep "already running" /var/log/coco/agent.log
```

### Network Gating

```bash
# Simulate offline condition
cat > /tmp/fake-curl <<'SH'
#!/bin/bash
exit 28  # timeout
SH
chmod +x /tmp/fake-curl

PATH="/tmp:$PATH" MAX_NETWORK_ATTEMPTS=2 ./scripts/run-scheduled-session.sh
grep "session will be skipped" /var/log/coco/session-scheduler.log
```

---

## Manual Tests

### Audio I/O (requires physical hardware)

```bash
# List available ALSA devices
aplay -l
arecord -l

# Test recording (3 seconds)
arecord -D plughw:3,0 -f S16_LE -r 24000 -c 1 -d 3 /tmp/test.wav

# Test playback
aplay -D plughw:3,0 /tmp/test.wav

# Full duplex test (speak while playing)
arecord -D plughw:3,0 -f S16_LE -r 24000 -c 1 | aplay -D plughw:3,0
```

### Real-time Session

```bash
# Set up environment
export COCO_AGENT_MODE=realtime
export OPENAI_API_KEY=sk-...
source ~/coco-device/.env

# Run session
npm start

# Expected behavior:
# 1. Agent speaks greeting
# 2. Listens for participant response
# 3. Runs through 6 activities
# 4. Posts summary to backend
```

### Mock Mode (no audio)

```bash
# Run in mock mode
export COCO_AGENT_MODE=mock
npm start

# Check logs
tail -f agent-activity.log
```

---

## Backend Communication Tests

### Mock Backend Server

```bash
# Start mock server
cat > /tmp/mock-backend.py <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, sys

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('content-length', 0))
        body = self.rfile.read(length).decode()
        print(f"{self.path}: {body}", file=sys.stderr, flush=True)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')

HTTPServer(('0.0.0.0', 8081), Handler).serve_forever()
PY

python3 /tmp/mock-backend.py 2>&1 | tee /tmp/backend.log &
MOCK_PID=$!

# Configure device to use mock backend
export COCO_BACKEND_URL=http://127.0.0.1:8081
export INGEST_SERVICE_TOKEN=test-token
export COCO_AGENT_MODE=mock

# Run session
npm start

# Check captured requests
cat /tmp/backend.log

# Cleanup
kill $MOCK_PID
```

### Heartbeat Test

```bash
# Run heartbeat script
./scripts/coco-heartbeat.sh

# Check heartbeat log
tail /var/log/coco/heartbeat.log

# Verify last_session_at file
cat /var/lib/coco/last_session_at
```

### Retry Logic Test

```bash
# Start server that returns 500 errors
cat > /tmp/fail-backend.py <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
count = 0

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        global count
        count += 1
        print(f"Request {count}", flush=True)
        if count < 3:
            self.send_response(500)
        else:
            self.send_response(200)
        self.end_headers()

HTTPServer(('0.0.0.0', 8082), Handler).serve_forever()
PY

python3 /tmp/fail-backend.py &
FAIL_PID=$!

export COCO_BACKEND_URL=http://127.0.0.1:8082
export COCO_BACKEND_RETRIES=3
npm start

# Should see retry attempts in logs
kill $FAIL_PID
```

---

## OTA Update Test

```bash
# Trigger manual update
sudo systemctl start coco-update.service

# Check update log
tail -f /var/log/coco/agent.log

# Verify version updated
cat /etc/coco-agent-version

# Check timer status
systemctl status coco-update.timer
```

---

## Pass Criteria

### Automated Tests
- [ ] `npm test` passes with 0 failures
- [ ] All 68 tests pass (45 agent + 9 backend + 14 planner)
- [ ] TypeScript compiles without errors

### Systemd Integration
- [ ] All timers active and scheduled correctly
- [ ] Agent service restarts on failure
- [ ] Concurrency lock prevents overlapping sessions
- [ ] OTA update service completes successfully

### Backend Communication
- [ ] Session summary POST succeeds with valid payload
- [ ] Heartbeat POST succeeds every 5 minutes
- [ ] Retry logic handles temporary failures
- [ ] Missing backend URL handled gracefully

### Audio (Manual)
- [ ] ALSA devices detected and working
- [ ] Recording captures clear audio
- [ ] Playback produces audible output
- [ ] Full-duplex works without feedback

### Real-time Session (Manual)
- [ ] Agent speaks greeting on connect
- [ ] Responds to participant speech
- [ ] Completes all 6 activity steps
- [ ] Handles "stop" command gracefully
- [ ] Posts summary with sentiment score

---

## Test Environment Setup

### Prerequisites
```bash
# Node.js 18+
node --version  # v18.x or higher

# Install dependencies
cd ~/coco-device
npm install

# Set up environment
cp .env.example .env
# Edit .env with valid credentials
```

### Test Data Cleanup
```bash
# Reset state files
sudo rm -f /var/lib/coco/last_session_at
sudo rm -f /tmp/coco-session-runner.lock

# Clear logs
sudo truncate -s 0 /var/log/coco/*.log

# Reset version file
echo "test-version" | sudo tee /etc/coco-agent-version
```

---

## Troubleshooting Test Failures

| Issue | Resolution |
|-------|------------|
| Tests hang | Check for zombie processes: `ps aux \| grep coco` |
| Backend tests fail | Verify `COCO_BACKEND_URL` not set in env |
| Audio tests fail | Check ALSA device: `aplay -l` |
| Lock errors | Remove stale lock: `rm /tmp/coco-session-runner.lock` |
| TypeScript errors | Run `npm run typecheck` for details |
