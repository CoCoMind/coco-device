# Coco Device Runtime Specification

## Overview

Coco is a cognitive companion that runs on Raspberry Pi devices, providing twice-daily voice-based coaching sessions. The system uses a synchronous pipeline with OpenAI's TTS, Whisper STT, and GPT-4o-mini for conversations.

### Key Capabilities
- **Synchronous voice pipeline** - TTS → Play → Record → STT → LLM
- **Scheduled sessions** - Twice daily (9am, 3pm)
- **Heartbeat monitoring** - Every 5 minutes
- **OTA updates** - Daily at 2:30am
- **Backend integration** - Session summaries and health reporting
- **Remote commands** - Admin panel integration

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
│  ├── src/syncSession.ts  → Main session runner                  │
│  ├── src/planner.ts      → Activity curriculum builder          │
│  ├── src/backend.ts      → Backend API client                   │
│  └── src/logger.ts       → Logging utility                      │
├─────────────────────────────────────────────────────────────────┤
│  Content                                                        │
│  └── config/curriculum/activities.json → Activity library       │
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
    │  - TTS (speech) │           │  - /ingest/session  │
    │  - STT (whisper)│           │  - /heartbeat       │
    │  - LLM (chat)   │           │  - /commands        │
    └─────────────────┘           └─────────────────────┘
```

---

## Session Pipeline

### Flow

```
1. INTRO
   └── TTS: "Hello! I'm Coco..." → Play → Record → STT
   └── Readiness check (3 attempts if no response)

2. ACTIVITIES (6 total)
   For each activity:
   ├── TTS: Activity prompt → Play
   ├── Record user response → STT
   ├── Check for stop phrase ("goodbye", "bye", etc.)
   ├── LLM: Generate contextual response
   ├── TTS: Response → Play
   └── Retry up to 2x if not heard

3. CLOSING
   └── LLM generates personalized closing based on session

4. BACKEND
   └── POST session summary
```

### Activity Categories

| Category | Duration | Purpose |
|----------|----------|---------|
| Orientation | ~1 min | Grounding, present-moment awareness |
| Language | ~2 min | Verbal expression, storytelling |
| Memory | ~2 min | Recall exercises |
| Attention | ~2 min | Focus, cognitive flexibility |
| Reminiscence | ~2 min | Life stories, social connection |
| Closing | ~1 min | Personalized wrap-up |

### Session Status Values

| Status | Meaning | Exit Code |
|--------|---------|-----------|
| `success` | Completed all activities | 0 |
| `early_exit` | User said stop phrase | 0 |
| `unattended` | No user input detected | 2 |
| `error_exit` | Unexpected error | 1 |
| `audio_unavailable` | Audio device not available | 3 |

---

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for TTS/STT/LLM |
| `COCO_BACKEND_URL` | Backend server URL |
| `INGEST_SERVICE_TOKEN` | Backend auth token |
| `COCO_DEVICE_ID` | Unique device identifier |
| `COCO_USER_EXTERNAL_ID` | User identifier |
| `COCO_PARTICIPANT_ID` | Participant ID |

### Audio Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `COCO_AUDIO_INPUT_DEVICE` | `pulse` | ALSA input device |
| `COCO_AUDIO_OUTPUT_DEVICE` | `pulse` | ALSA output device |
| `COCO_AUDIO_DISABLE` | `0` | Set to `1` for dry run mode |

### Recording Settings (hardcoded)

| Setting | Value |
|---------|-------|
| Sample rate | 24000 Hz |
| Channels | 1 (mono) |
| Format | S16_LE |
| Initial record cap | 30 seconds |
| Extended record cap | 60 seconds (if still speaking) |
| Min speech RMS | 300 |
| Silence duration | 2500 ms |

---

## Systemd Services

### Timers

| Timer | Schedule | Purpose |
|-------|----------|---------|
| `coco-agent-scheduler.timer` | 09:00, 15:00 | Twice-daily sessions |
| `coco-heartbeat.timer` | Every 5 min | Health monitoring |
| `coco-command-poller.timer` | Every 30s | Admin command polling |
| `coco-update.timer` | 02:30 daily | Software updates |

### Managing Services

```bash
# Enable all timers
sudo systemctl enable --now coco-agent-scheduler.timer coco-heartbeat.timer coco-update.timer coco-command-poller.timer

# Check timer status
systemctl list-timers 'coco-*'

# Manual session run
npm start

# View logs
journalctl -u coco-agent-scheduler.service -f
```

---

## Backend Integration

### Session Summary
`POST {COCO_BACKEND_URL}/internal/ingest/session_summary`

```json
{
  "session_id": "uuid",
  "plan_id": "uuid",
  "user_external_id": "string",
  "participant_id": "string",
  "device_id": "string",
  "started_at": "ISO8601",
  "ended_at": "ISO8601",
  "duration_seconds": 600,
  "turn_count": 6,
  "status": "success|early_exit|unattended",
  "sentiment_summary": "positive|neutral|negative",
  "sentiment_score": 0.75
}
```

### Heartbeat
`POST {COCO_BACKEND_URL}/internal/heartbeat`

```json
{
  "device_id": "string",
  "agent_version": "string",
  "connectivity": "wifi|lte|offline",
  "agent_status": "ok|degraded|crashed",
  "last_session_at": "ISO8601"
}
```

### Remote Commands

| Command | Action |
|---------|--------|
| `REBOOT` | Reboot device |
| `RESTART_SERVICE` | Restart coco-agent service |
| `UPLOAD_LOGS` | Upload recent logs to backend |
| `UPDATE_NOW` | Trigger OTA update |

---

## File System Layout

```
~/coco-device/
├── .env                              # Configuration (gitignored)
├── src/
│   ├── syncSession.ts                # Main session runner
│   ├── planner.ts                    # Activity selection
│   ├── backend.ts                    # Backend API client
│   └── logger.ts                     # Logging utility
├── config/
│   └── curriculum/
│       ├── activities.json           # Activity library
│       └── README.md                 # Editing guide
├── scripts/
│   ├── coco-native-agent-boot.sh
│   ├── run-scheduled-session.sh
│   ├── coco-heartbeat.sh
│   ├── coco-command-poller.sh
│   └── coco-update.sh
└── tests/

/var/log/coco/
├── agent.log                         # Session logs
├── session-scheduler.log             # Scheduler logs
├── heartbeat.log                     # Heartbeat logs
└── command-poller.log                # Command logs

/usr/local/bin/
├── coco-native-agent-boot.sh         # Installed scripts
├── run-scheduled-session.sh
├── coco-heartbeat.sh
├── coco-command-poller.sh
└── coco-update.sh
```

---

## Troubleshooting

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| No audio output | Wrong ALSA device | Check `aplay -l`, update env |
| No audio input | Wrong ALSA device | Check `arecord -l`, update env |
| Session ends immediately | Stop phrase hallucination | Check Whisper transcription |
| "Unattended" status | No user response | Verify audio hardware |
| Backend POST fails | Auth or network issue | Check token and URL |

### Quick Diagnostics

```bash
# Check service status
for svc in coco-agent coco-heartbeat coco-command-poller; do
  echo -n "$svc.service: "; systemctl is-active $svc.service
done

# Check timer status
for timer in coco-heartbeat coco-command-poller coco-update coco-agent-scheduler; do
  echo -n "$timer.timer: "; systemctl is-active $timer.timer
done

# Test audio
arecord -D pulse -f S16_LE -r 24000 -c 1 -d 3 test.wav
aplay -D pulse test.wav

# View recent logs
tail -50 /var/log/coco/agent.log
```
