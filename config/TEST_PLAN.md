# Coco Device Test Plan

## Overview

Test plan covering validation of the Coco cognitive companion device:
- **Automated tests** - TypeScript unit tests
- **Manual tests** - Session flow, audio I/O

---

## Quick Start

```bash
cd ~/coco-device

# Run all automated tests
npm test

# Individual test suites
npm run test:backend   # Backend API tests (9 tests)
npm run test:planner   # Activity planner tests (14 tests)
npm run test:scripts   # Shell script validation (35 tests)

# Type checking only
npm run typecheck
```

---

## Automated Test Suites

### Backend Tests (`tests/backend.test.ts`) - 9 tests

| Category | Tests | Description |
|----------|-------|-------------|
| createSessionIdentifiers | 5 | UUID generation, uniqueness |
| Payload Types | 2 | TypeScript type validation |
| Integration | 2 | Live backend POST (if configured) |

### Planner Tests (`tests/planner.test.ts`) - 14 tests

| Category | Tests | Description |
|----------|-------|-------------|
| buildPlan | 9 | Plan generation, category ordering |
| Activity Structure | 3 | Field validation, type checking |
| Edge Cases | 2 | Stress testing, consistency |

**Key scenarios:**
- Exactly 6 activities per plan
- Correct category order (orientation → language → memory → attention → reminiscence → closing)
- Duration clamping between 1-2 minutes
- No duplicate activity IDs in single plan

### Script Tests (`tests/scripts.test.ts`) - 35 tests

| Category | Tests | Description |
|----------|-------|-------------|
| Existence | 5 | All required scripts exist |
| Syntax | 5 | Valid bash syntax |
| Shebang | 5 | Proper shebang lines |
| Executable | 5 | Correct permissions |
| Content | 15 | Required functionality present |

---

## Manual Test Cases

### Test Case 1: Full 6-Activity Session

**Steps:**
1. Run `npm start`
2. Respond to "Are you ready to begin?"
3. Engage with all 6 activities
4. Let session complete naturally

**Expected:**
- Status: `success`
- Utterances: 6+
- Backend POST: 200 OK

### Test Case 2: Stop Phrase Mid-Session

**Steps:**
1. Run `npm start`
2. Respond to readiness check
3. Say "goodbye" or "bye" during any activity

**Expected:**
- Status: `early_exit`
- Session ends gracefully with farewell message
- Backend POST: 200 OK

### Test Case 3: Retry on Missed Response

**Steps:**
1. Run `npm start`
2. Stay silent when asked to respond
3. Observe retry prompts

**Expected:**
- Coco asks up to 2 times: "I didn't quite catch that..."
- After 3 failed attempts, moves to next activity

### Test Case 4: Readiness Check Timeout

**Steps:**
1. Run `npm start`
2. Stay silent for all 3 readiness attempts

**Expected:**
- Status: `unattended`
- Exit code: 2
- Session ends with "I'll be here when you're ready"

### Test Case 5: Audio Device Test

```bash
# Test recording (3 seconds)
arecord -D pulse -f S16_LE -r 24000 -c 1 -d 3 /tmp/test.wav

# Test playback
aplay -D pulse /tmp/test.wav
```

---

## Integration Tests

### Systemd Services

```bash
# Check all timers are active
systemctl list-timers 'coco-*'

# Expected:
# coco-agent-scheduler.timer - 09:00, 15:00
# coco-heartbeat.timer       - every 5 min
# coco-update.timer          - daily 02:30
# coco-command-poller.timer  - every 30s
```

### Backend Communication

```bash
# Test heartbeat
./scripts/coco-heartbeat.sh
tail /var/log/coco/heartbeat.log

# Test command poller
./scripts/coco-command-poller.sh
tail /var/log/coco/command-poller.log
```

### Concurrency Lock

```bash
# Start a session
npm start &
sleep 5

# Try to start another (should be blocked)
npm start
# Should see "Another Coco session is already running"
```

---

## Pass Criteria

### Automated Tests
- [ ] `npm test` passes with 0 failures
- [ ] All 58 tests pass (9 backend + 14 planner + 35 scripts)
- [ ] TypeScript compiles without errors

### Session Flow
- [ ] Readiness check works (3 attempts)
- [ ] All 6 activities execute in order
- [ ] Retry logic works when response not heard
- [ ] Stop phrases trigger early exit
- [ ] Personalized closing references session content

### Backend Integration
- [ ] Session summary POST succeeds
- [ ] Heartbeat POST succeeds
- [ ] Correct status values sent (success/early_exit/unattended)

### Audio (Manual)
- [ ] Recording captures clear audio
- [ ] Playback produces audible output
- [ ] TTS quality is acceptable
- [ ] STT transcription is accurate

---

## Known Issues

### Whisper Hallucination
Whisper may hallucinate phrases like "Silence." or "Thanks for watching!" when given silent audio. This can:
- Trigger false stop phrases
- Cause incorrect transcripts
- Prevent accurate unattended detection

**Workaround:** Ensure user is present and speaking during sessions.

---

## Test Environment Setup

```bash
# Prerequisites
node --version  # v20.x or higher

# Install dependencies
cd ~/coco-device
npm install

# Set up environment
cp .env.example .env
# Edit .env with valid credentials

# Verify audio devices
aplay -l
arecord -l
```

### Cleanup Between Tests

```bash
# Remove lock file
rm -f /tmp/coco-session-runner.lock

# Clear logs (optional)
sudo truncate -s 0 /var/log/coco/*.log
```
