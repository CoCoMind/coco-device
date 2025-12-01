# Coco Device Install Guide (Raspberry Pi OS Lite)

## Prerequisites
- Raspberry Pi OS Lite (64-bit) flashed to SD card
- SSH access enabled
- Network connectivity (Ethernet or Wi-Fi)

## Quick Install (recommended)
```bash
curl -sSL https://raw.githubusercontent.com/jh2k2/coco-hardware-scripts/main/install.sh | sudo bash
```

## Manual Install
```bash
# Install dependencies
sudo apt-get update
sudo apt-get install -y curl git alsa-utils build-essential

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and install
cd ~
git clone https://github.com/jh2k2/coco-hardware-scripts.git coco-device
cd coco-device
sudo ./install.sh --local
```

## Configuration

### Option 1: Provisioning Script (Recommended)
```bash
cd ~/coco-device
sudo ./scripts/provision-device.sh
```
The script will:
- Prompt for participant ID, device ID, API keys
- Auto-generate device ID if not provided
- Write `.env` with secure permissions (600)
- Install log rotation config
- Write version file to `/etc/coco-agent-version`
- Restart all services

### Option 2: Manual Configuration
```bash
cd ~/coco-device
cp .env.example .env
nano .env   # Fill in required values (see .env.example for documentation)
```

Required environment variables:
- `COCO_DEVICE_ID` - Unique device identifier
- `COCO_USER_EXTERNAL_ID` - User ID for backend
- `COCO_PARTICIPANT_ID` - Participant ID
- `COCO_BACKEND_URL` - Backend API URL
- `INGEST_SERVICE_TOKEN` - Backend API token
- `OPENAI_API_KEY` - OpenAI API key

## Enable Services
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now coco-agent-scheduler.timer coco-heartbeat.timer coco-update.timer coco-command-poller.timer
```

## Manual Session
```bash
sudo systemctl start coco-agent.service
```

## OTA Updates
```bash
sudo /usr/local/bin/coco-update.sh
```
The `coco-update.timer` runs daily at 02:30 (±15min jitter). Disable with:
```bash
sudo systemctl disable --now coco-update.timer
```

## Logs & State
| File | Purpose |
|------|---------|
| `/var/log/coco/agent.log` | Agent session logs |
| `/var/log/coco/session-scheduler.log` | Scheduler logs |
| `/var/log/coco/heartbeat.log` | Heartbeat logs |
| `/var/log/coco/command-poller.log` | Command poller logs |
| `/var/lib/coco/last_session_at` | Last session timestamp |
| `/etc/coco-agent-version` | Installed version |

## Reliability Features

### Self-Healing Services
- Agent service auto-restarts on failure (`Restart=on-failure`, 10s delay)
- Session failures are reported to backend (`session_start_failed` event)
- Connection retries with exponential backoff (3 attempts)

### Log Management
- Logs rotate daily (7-day retention)
- Max 50MB per log file
- Transcripts are truncated to 50 chars for privacy

### Network Resilience
- Ephemeral key fetch: 3 retries with backoff
- WebSocket connection: 3 retries with backoff
- Backend API: configurable retries via `COCO_BACKEND_RETRIES`

## Troubleshooting
```bash
# Check service status
systemctl status coco-agent-scheduler.timer
journalctl -u coco-agent-scheduler.service --since "1 hour ago"

# Check timer schedule
systemctl list-timers --all | grep coco

# Manual test run
sudo systemctl start coco-agent-scheduler.service

# Test audio devices
aplay -l                                           # List output devices
arecord -l                                         # List input devices
aplay -D plughw:3,0 /usr/share/sounds/alsa/Front_Center.wav  # Test speaker
arecord -D plughw:3,0 -d 3 -f S16_LE -r 24000 test.wav       # Record 3s
aplay test.wav                                     # Play back recording
```
