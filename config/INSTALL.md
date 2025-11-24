# Coco Device Install Guide (Raspberry Pi OS Lite)

## Prereqs
- Raspberry Pi OS Lite flashed to SD card
- SSH reachable (Ethernet or Wi-Fi via wifi.conf USB)
- GitHub repo URL for this project (set `REPO_URL` below)

## One-liner bootstrap (run on the Pi)
```bash
curl -sSL https://raw.githubusercontent.com/jh2k2/coco-hardware-scripts/main/install.sh | sudo bash
```

## Manual steps (if you prefer)
```bash
sudo apt-get update
sudo apt-get install -y curl git alsa-utils build-essential
# Install Node 20 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

REPO_URL=https://github.com/REPO_OWNER/REPO_NAME.git
BRANCH=main
RUN_USER=${SUDO_USER:-${USER}}
cd /home/${RUN_USER}
git clone "${REPO_URL}" coco-device
cd coco-device
sudo ./install.sh --local
```

## Configure env
```bash
cd /home/${USER}/coco-device
cp .env.example .env
nano .env   # fill COCO_DEVICE_ID, COCO_USER_EXTERNAL_ID, COCO_PARTICIPANT_ID, COCO_BACKEND_URL, INGEST_SERVICE_TOKEN, OPENAI_API_KEY
```

## Wi-Fi provisioning
- Create `wifi.conf` on a USB drive:
```
ssid=YourSSID
psk=YourPassword
hidden=0
priority=1
```
- Insert USB; device will announce status and apply credentials.

## Start/enable services
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now coco-agent.service coco-agent-scheduler.timer coco-heartbeat.timer wifi-provision.service
```

## Update (pull latest)
```bash
sudo /usr/local/bin/coco-update.sh
```

## Logs & state
- Session scheduler: /var/log/coco/session-scheduler.log
- Heartbeat: /var/log/coco/heartbeat.log
- Wi-Fi provisioning: /var/log/coco/wifi-provision.log
- Last session timestamp: /var/lib/coco/last_session_at
```
