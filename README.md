# Coco Device

Raspberry Pi voice agent for cognitive companion sessions. Runs twice-daily 10-minute sessions with TTS, STT, and LLM-powered conversations.

## Architecture

Simple synchronous pipeline:
1. **TTS** (OpenAI) → Generate speech
2. **Play** (aplay) → Output audio
3. **Record** (arecord) → Capture user response
4. **STT** (Whisper) → Transcribe audio
5. **LLM** (GPT-4o-mini) → Generate contextual response
6. Repeat for 6 activities

## Requirements

- Raspberry Pi OS Lite (64-bit) with SSH
- Node.js 20+ and ALSA (`aplay`/`arecord`)
- OpenAI API key
- Backend URL + ingest token

## Quick Install

```bash
# Bootstrap script (installs Node 20, clones repo, sets up systemd)
curl -sSL https://raw.githubusercontent.com/jh2k2/coco-hardware-scripts/main/install.sh | sudo bash

# Provision device (interactive)
cd ~/coco-device
sudo ./scripts/provision-device.sh
```

## Manual Setup

```bash
git clone https://github.com/jh2k2/coco-hardware-scripts.git coco-device
cd coco-device
npm install
cp .env.example .env
# Edit .env with your configuration
npm start
```

## Configuration

Required environment variables (`.env`):

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for TTS/STT/LLM |
| `COCO_DEVICE_ID` | Unique device identifier |
| `COCO_USER_EXTERNAL_ID` | User identifier for backend |
| `COCO_PARTICIPANT_ID` | Participant ID |
| `COCO_BACKEND_URL` | Backend API URL |
| `INGEST_SERVICE_TOKEN` | Backend auth token |

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `COCO_AUDIO_DISABLE` | `0` | Set to `1` to disable audio (dry run) |
| `COCO_AUDIO_OUTPUT_DEVICE` | `pulse` | ALSA output device |
| `COCO_AUDIO_INPUT_DEVICE` | `pulse` | ALSA input device |

## Tests

```bash
npm test              # typecheck + all tests
npm run test:backend  # backend API tests (9 tests)
npm run test:planner  # planner tests (14 tests)
npm run test:scripts  # shell script validation (35 tests)
```

## Systemd Services

| Service | Description |
|---------|-------------|
| `coco-agent-scheduler.timer` | Runs sessions at 9am and 3pm |
| `coco-heartbeat.timer` | Sends heartbeat every 5 minutes |
| `coco-update.timer` | Daily OTA updates at 2:30am |
| `coco-command-poller.timer` | Polls for remote commands |

Enable all:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now coco-agent-scheduler.timer coco-heartbeat.timer coco-update.timer coco-command-poller.timer
```

## Logs

- `/var/log/coco/agent.log` - Session logs
- `/var/log/coco/session-scheduler.log` - Scheduler logs
- `/var/log/coco/heartbeat.log` - Heartbeat logs

## Curriculum

Activity content is in `config/curriculum/activities.json`. See `config/curriculum/README.md` for editing guide.

## Documentation

- [DEVICE_SPEC.md](config/DEVICE_SPEC.md) - Full device specification
- [INSTALL.md](config/INSTALL.md) - Manual installation guide
- [SYNC_PIPELINE.md](docs/SYNC_PIPELINE.md) - Pipeline architecture
