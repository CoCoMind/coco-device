# Coco Device Install Guide (Raspberry Pi OS Lite)

## Prereqs
- Raspberry Pi OS Lite flashed to SD card
- SSH reachable (Ethernet or your own Wi-Fi setup)
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
Replace `REPO_URL`/`BRANCH` with `https://github.com/jh2k2/coco-hardware-scripts.git` and your target ref if not using the one-liner.

## Configure env
```bash
cd /home/${USER}/coco-device
cp .env.example .env
nano .env   # fill COCO_DEVICE_ID, COCO_USER_EXTERNAL_ID, COCO_PARTICIPANT_ID, COCO_BACKEND_URL, INGEST_SERVICE_TOKEN, OPENAI_API_KEY
```

## Start/enable services
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now coco-agent-scheduler.timer coco-heartbeat.timer coco-update.timer
# (coco-agent.service is available for manual runs if desired)
```

## Update (pull latest)
```bash
sudo /usr/local/bin/coco-update.sh
```
The OTA timer (`coco-update.timer`) also runs daily at 02:30 with jitter. Disable it with `sudo systemctl disable --now coco-update.timer` if you need to pin a version.

## Logs & state
- Session scheduler: /var/log/coco/session-scheduler.log
- Heartbeat: /var/log/coco/heartbeat.log
- Last session timestamp: /var/lib/coco/last_session_at
