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

## Troubleshooting
```bash
# Check service status
systemctl status coco-agent-scheduler.timer
journalctl -u coco-agent-scheduler.service --since "1 hour ago"

# Check timer schedule
systemctl list-timers --all | grep coco

# Manual test run
sudo systemctl start coco-agent-scheduler.service
```
