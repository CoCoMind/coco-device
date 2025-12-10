# Coco Device Install Guide (Raspberry Pi OS Lite)

## Prerequisites
- Raspberry Pi OS Lite (64-bit) flashed to SD card
- SSH access enabled
- Initial network connectivity (Ethernet or temporary WiFi)

## Quick Install (recommended)
```bash
curl -sSL https://raw.githubusercontent.com/jh2k2/coco-hardware-scripts/main/install.sh | sudo bash
```

## WiFi Provisioning (for field deployment)

The device includes **automatic WiFi provisioning** via captive portal. This allows you to deploy devices to different locations without pre-configuring WiFi:

### How It Works
1. When the device can't connect to a known WiFi network, it creates a hotspot named **CoCo-XXXX** (where XXXX is a unique identifier)
2. Connect to this hotspot from your phone or laptop
3. A captive portal automatically appears to select the target WiFi network
4. Enter the WiFi password and the device will connect

### Field Deployment Workflow
1. Flash SD card with Raspberry Pi OS Lite
2. Enable SSH (create empty `ssh` file in boot partition)
3. Connect device via Ethernet for initial install
4. Run quick install command above
5. Run `sudo ./scripts/provision-device.sh`
6. Disconnect Ethernet - device is now portable
7. At deployment location: power on, connect to CoCo-XXXX hotspot, configure WiFi

### Fallback Behavior
- If the user's WiFi goes down or password changes, the device automatically returns to hotspot mode
- Connect to the hotspot to reconfigure WiFi credentials
- All stored configuration (participant ID, API keys) is preserved

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
- **Generate SSH deploy key** (see below)
- Install log rotation config
- Write version file to `/etc/coco-agent-version`
- Restart all services

### SSH Deploy Key Setup (Required for OTA)

The provisioning script generates a **unique SSH key per device** for secure GitHub access. You must add this key to GitHub:

1. During provisioning, a public key will be displayed:
   ```
   ------- PUBLIC KEY (copy everything below) -------
   ssh-ed25519 AAAA... coco-device-raspberrypi-20251208
   ------- END PUBLIC KEY -------
   ```

2. Go to: https://github.com/jh2k2/coco-hardware-scripts/settings/keys

3. Click **"Add deploy key"**:
   - **Title:** `coco-<hostname>` (e.g., `coco-raspberrypi`)
   - **Key:** Paste the public key
   - **Allow write access:** Leave unchecked (read-only is fine)

4. Press Enter in the terminal to continue provisioning

**Why per-device keys?** Each device has its own keypair for security. If one device is compromised, revoke only that key without affecting others.

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

### Automatic Rollback (v0.1.6+)

OTA updates include automatic rollback on failure:
1. Pre-update commit is saved
2. After `npm install`, a health check runs:
   - Verifies `src/syncSession.ts` exists
   - Verifies `package.json` is valid
   - Verifies `node_modules` exists
   - Runs TypeScript compilation check
3. If health check fails → automatic rollback to previous commit
4. Logs show: `ROLLBACK: Reverted to <commit>`

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

### API Retry Logic (v0.1.6+)
All OpenAI API calls (TTS, STT, LLM) have automatic retry:
- **Timeout:** 30s (configurable via `COCO_API_TIMEOUT_MS`)
- **Retries:** 2 attempts (configurable via `COCO_API_RETRIES`)
- **Retry delay:** 500ms
- **Retryable errors:** timeout, ECONNRESET, ETIMEDOUT, network errors, 5xx

Backend API calls also retry:
- **Timeout:** 10s (via `COCO_BACKEND_TIMEOUT_MS`)
- **Retries:** 1 (via `COCO_BACKEND_RETRIES`)

### OTA Rollback (v0.1.6+)
- Updates automatically rollback if health check fails
- Previous commit saved before update
- Health check verifies code structure and TypeScript compilation

### Log Security
- Logs created with `0600` permissions (owner-only read)
- Logs rotate daily (7-day retention)
- Max 50MB per log file

### Self-Healing Services
- Agent service auto-restarts on failure (`Restart=on-failure`, 10s delay)
- Session failures are reported to backend (`session_start_failed` event)

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
