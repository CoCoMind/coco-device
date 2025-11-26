# Coco Device Runtime Specification (Raspberry Pi)

## Overview

Coco is a cognitive coaching agent that runs on Raspberry Pi devices, providing real-time voice-based coaching sessions to participants. The system uses OpenAI's Realtime API for speech synthesis and recognition, with a structured curriculum of cognitive activities.

### Key Capabilities
- **Real-time voice interaction** via OpenAI Realtime API (WebSocket)
- **Scheduled coaching sessions** (twice daily by default)
- **Heartbeat monitoring** for fleet health tracking
- **OTA updates** for automatic software deployment
- **Sentiment analysis** of participant responses
- **Backend telemetry** for session tracking and analytics
- **Remote command execution** via admin panel integration

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Raspberry Pi                            │
├─────────────────────────────────────────────────────────────────┤
│  systemd timers                                                 │
│  ├── coco-agent-scheduler.timer (09:00, 15:00)                  │
│  ├── coco-heartbeat.timer (every 5 min)                         │
│  ├── coco-command-poller.timer (every 30s)                      │
│  └── coco-update.timer (daily 02:30)                            │
├─────────────────────────────────────────────────────────────────┤
│  Agent Runtime (Node.js/TypeScript)                             │
│  ├── src/runAgent.ts      → Entry point                         │
│  ├── src/agent.ts         → Session management, conversation    │
│  ├── src/audioIO.ts       → ALSA audio capture/playback         │
│  ├── src/planner.ts       → Activity curriculum builder         │
│  ├── src/backend.ts       → Backend API client                  │
│  ├── src/tools.ts         → Agent tools (telemetry, end_session)│
│  ├── src/logger.ts        → Centralized logging utility         │
│  ├── src/telemetry.ts     → Activity event logging              │
│  └── src/mockAgent.ts     → Mock mode for testing               │
├─────────────────────────────────────────────────────────────────┤
│  Scripts                                                        │
│  ├── coco-native-agent-boot.sh  → Agent launcher                │
│  ├── run-scheduled-session.sh   → Scheduler entry point         │
│  ├── coco-heartbeat.sh          → Health reporting              │
│  ├── coco-command-poller.sh     → Admin command executor        │
│  └── coco-update.sh             → OTA update script             │
└─────────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
    ┌─────────────────┐           ┌─────────────────────┐
    │  OpenAI API     │           │  Coco Backend       │
    │  - Realtime WS  │           │  - /internal/ingest │
    │  - Responses    │           │  - /internal/heartbeat│
    └─────────────────┘           │  - /internal/commands│
                                  └─────────────────────┘
```

---

## Device Identity & Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for Realtime and sentiment APIs |
| `COCO_BACKEND_URL` | Yes | Backend server URL (e.g., `https://coco-backend.fly.dev`) |
| `INGEST_SERVICE_TOKEN` | Yes | Bearer token for backend authentication |
| `COCO_DEVICE_ID` | Yes | Unique device identifier |
| `COCO_USER_EXTERNAL_ID` | Yes | User/participant external ID |
| `COCO_PARTICIPANT_ID` | No | Participant ID (defaults to user external ID) |
| `COCO_AGENT_MODE` | No | `realtime` (default) or `mock` for testing |

### Audio Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `COCO_AUDIO_INPUT_DEVICE` | `plughw:3,0` | ALSA input device |
| `COCO_AUDIO_OUTPUT_DEVICE` | `plughw:3,0` | ALSA output device |
| `COCO_AUDIO_SAMPLE_RATE` | `24000` | Audio sample rate (Hz) |
| `COCO_AUDIO_CHANNELS` | `1` | Mono audio |
| `COCO_AUDIO_SAMPLE_FORMAT` | `S16_LE` | 16-bit signed little-endian |
| `COCO_AUDIO_DISABLE` | `0` | Set to `1` for text-only mode |

### Session Timing

| Variable | Default | Description |
|----------|---------|-------------|
| `COCO_INTRO_RESPONSE_WINDOW_MS` | `8000` | Wait time for intro response |
| `COCO_MIN_LISTEN_WINDOW_MS` | `12000` | Minimum participant listen time |
| `COCO_MAX_LISTEN_WINDOW_MS` | `20000` | Maximum participant listen time |
| `COCO_FINAL_RESPONSE_WINDOW_MS` | `8000` | Wait time for final response |
| `COCO_LISTEN_GRACE_MS` | `2000` | Grace period before timeout starts |

### Backend Communication

| Variable | Default | Description |
|----------|---------|-------------|
| `COCO_BACKEND_TIMEOUT_MS` | `10000` | Request timeout |
| `COCO_BACKEND_RETRIES` | `1` | Number of retry attempts |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `COCO_LOG_LEVEL` | `debug` | Log level: `debug`, `info`, `warn`, `error` |

---

## Systemd Services

### Service Units

| Service | Purpose | Trigger |
|---------|---------|---------|
| `coco-agent.service` | Manual/ad-hoc agent runs | Manual start |
| `coco-agent-scheduler.service` | Scheduled session runner | Timer |
| `coco-heartbeat.service` | Health reporting | Timer |
| `coco-command-poller.service` | Admin command execution | Timer |
| `coco-update.service` | OTA updates | Timer |

### Timer Schedule

| Timer | Schedule | Jitter | Purpose |
|-------|----------|--------|---------|
| `coco-agent-scheduler.timer` | 09:00, 15:00 | None | Twice-daily sessions |
| `coco-heartbeat.timer` | Every 5 min | 60s | Health monitoring |
| `coco-command-poller.timer` | Every 30s | 5s | Admin command polling |
| `coco-update.timer` | 02:30 daily | 15 min | Software updates |

---

## Agent Session Flow

### Startup Sequence
1. `runAgent.ts` fetches ephemeral key from OpenAI
2. Creates `RealtimeSession` with WebSocket transport
3. Initializes ALSA audio binding (or text-only stub)
4. Builds activity plan from `activities.json`
5. Connects to OpenAI Realtime API

### Session Execution
1. **Intro** - Agent greets participant, waits for response
2. **Activities** (6 steps) - Curriculum-driven cognitive exercises:
   - Orientation (~1 min)
   - Language (~2 min)
   - Memory (~2 min)
   - Attention (~2 min)
   - Reminiscence (~2 min)
   - Closing (~1 min)
3. **Wrap-up** - Final message, sentiment analysis
4. **Summary** - POST to backend with session metadata

### Error Handling & Resilience

| Scenario | Behavior |
|----------|----------|
| No participant response | Agent continues with encouragement |
| Network timeout | Exponential backoff retry (300ms, 600ms, 1200ms) |
| Backend POST failure | Logs error, continues session |
| "Stop"/"end session" detected | Graceful early termination |
| OpenAI API error | Retry once, then throw |

---

## Backend Integration

### Session Summary Endpoint
`POST {COCO_BACKEND_URL}/internal/ingest/session_summary`

**Payload:**
```json
{
  "session_id": "uuid",
  "plan_id": "uuid",
  "user_external_id": "string",
  "participant_id": "string",
  "device_id": "string",
  "label": "string",
  "started_at": "ISO8601",
  "ended_at": "ISO8601",
  "duration_seconds": 600,
  "turn_count": 10,
  "sentiment_summary": "positive|neutral|negative|no_input",
  "sentiment_score": 0.85,
  "notes": "transcript excerpt (max 1800 chars)"
}
```

### Heartbeat Endpoint
`POST {COCO_BACKEND_URL}/internal/heartbeat`

**Payload:**
```json
{
  "device_id": "string",
  "agent_version": "string",
  "connectivity": "wifi|lte|offline",
  "network": {
    "interface": "wlan0",
    "ip": "192.168.1.100",
    "signal_rssi": -50,
    "latency_ms": 25
  },
  "agent_status": "ok|degraded|crashed",
  "last_session_at": "ISO8601"
}
```

### Admin Panel Integration

The command poller enables remote device management from the admin panel.

#### Poll Commands Endpoint
`GET {COCO_BACKEND_URL}/internal/commands/pending`

**Headers:**
- `Authorization: Bearer ${INGEST_SERVICE_TOKEN}`
- `X-Device-ID: ${COCO_DEVICE_ID}`

**Response:**
```json
{
  "command": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "command_type": "REBOOT",
    "payload": null,
    "created_at": "2024-11-25T14:30:00Z"
  }
}
```
Returns `{"command": null}` if no pending commands.

#### Report Status Endpoint
`POST {COCO_BACKEND_URL}/internal/commands/{command_id}/status`

**Payload:**
```json
{
  "status": "COMPLETED"
}
```
Or on failure:
```json
{
  "status": "FAILED",
  "error": "Permission denied"
}
```

#### Upload Logs Endpoint
`POST {COCO_BACKEND_URL}/internal/ingest/logs`

**Payload:**
```json
{
  "device_id": "string",
  "content": "log content..."
}
```

#### Supported Commands

| Command | Action | Notes |
|---------|--------|-------|
| `REBOOT` | `sudo reboot` | Status reported before reboot |
| `RESTART_SERVICE` | `sudo systemctl restart coco-agent.service` | Restarts main agent |
| `UPLOAD_LOGS` | Collect logs → POST to backend | Last 200 lines from each log |
| `UPDATE_NOW` | Run `/usr/local/bin/coco-update.sh` | Git pull + restart |

---

## File System Layout

### Application Files
```
~/coco-device/
├── .env                    # Device configuration (gitignored)
├── .env.example            # Configuration template
├── src/                    # TypeScript source
├── scripts/                # Shell scripts
├── systemd/                # Service unit files
├── tests/                  # Test suite
└── config/                 # Documentation
```

### Runtime Files
```
/etc/coco-agent-version           # Installed version string
/var/log/coco/
├── agent.log                     # Agent runtime logs
├── session-scheduler.log         # Scheduler logs
├── heartbeat.log                 # Heartbeat logs
└── command-poller.log            # Command poller logs
/var/lib/coco/
└── last_session_at               # Timestamp of last session
/tmp/coco-session-runner.lock     # Concurrency lock
/tmp/coco-command-poller.lock     # Command poller lock
```

### Installed Scripts
```
/usr/local/bin/
├── coco-native-agent-boot.sh
├── run-scheduled-session.sh
├── coco-heartbeat.sh
├── coco-command-poller.sh
└── coco-update.sh
```

---

## Multi-Device Deployment (5-10 Devices)

### Per-Device Configuration
Each device requires unique values in `.env`:
- `COCO_DEVICE_ID` - Unique device identifier
- `COCO_USER_EXTERNAL_ID` - Associated user/participant
- `COCO_PARTICIPANT_ID` - Participant number (optional)

### Shared Configuration
These can be identical across devices:
- `OPENAI_API_KEY`
- `COCO_BACKEND_URL`
- `INGEST_SERVICE_TOKEN`

### Fleet Considerations

| Concern | Current State | Recommendation |
|---------|--------------|----------------|
| Config provisioning | Manual `.env` setup | Create provisioning script |
| Log aggregation | Local logs only | Add centralized logging |
| Update rollout | All devices simultaneously | Implement canary groups |
| Monitoring | 5-min heartbeat | Consider 1-2 min for faster detection |
| Rate limiting | None | Add per-device throttling |

---

## Security Considerations

### Credential Storage
- API keys stored in `.env` (gitignored)
- No encryption at rest
- Recommend: Use secrets manager for production

### Network Security
- All API calls over HTTPS
- Bearer token authentication
- No certificate pinning

### Audio Privacy
- Transcripts stored in logs (plaintext)
- Sentiment analysis processes participant speech
- Recommend: Implement log rotation and encryption

---

## Troubleshooting

### Common Issues

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| No audio | Wrong ALSA device | Check `aplay -l`, update `COCO_AUDIO_*` |
| Session hangs | Network timeout | Check connectivity, increase timeouts |
| Heartbeat failing | Backend unreachable | Verify `COCO_BACKEND_URL` and token |
| Lock contention | Concurrent sessions | Check for zombie processes |
| OTA fails | Git conflicts | Manual `git reset --hard` |

### Log Locations
- Agent: `/var/log/coco/agent.log`
- Scheduler: `/var/log/coco/session-scheduler.log`
- Heartbeat: `/var/log/coco/heartbeat.log`
- Command Poller: `/var/log/coco/command-poller.log`
- Systemd: `journalctl -u coco-agent.service`

### Health Checks
```bash
# Check all timers
systemctl list-timers 'coco-*'

# Check agent status
systemctl status coco-agent.service

# Test backend connectivity
curl -X POST ${COCO_BACKEND_URL}/internal/heartbeat \
  -H "Authorization: Bearer ${INGEST_SERVICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"test"}'

# Test audio devices
arecord -D plughw:3,0 -f S16_LE -r 24000 -c 1 -d 3 test.wav
aplay -D plughw:3,0 test.wav
```
