# Coco Device

Hardware-ready Raspberry Pi build for the Coco voice agent. Provides realtime speech I/O, twice-daily scheduled sessions, a heartbeat, and backend summaries.

## What you need
- Raspberry Pi OS Lite (64-bit) with SSH enabled
- Node.js 20+ and ALSA (`aplay`/`arecord`)
- Backend URL + ingest token and device/user/participant IDs
- OpenAI API key (or pre-minted realtime ephemeral key)

## Install on a Pi
1. Flash Raspberry Pi OS Lite and get network access.
2. Run the bootstrap (installs Node 20, pulls this repo, installs units/deps):
   ```bash
   curl -sSL https://raw.githubusercontent.com/jh2k2/coco-hardware-scripts/main/install.sh | sudo bash
   ```
3. Configure env:
   ```bash
   cd ~/coco-device
   cp .env.example .env
   nano .env   # fill COCO_DEVICE_ID, COCO_USER_EXTERNAL_ID, COCO_PARTICIPANT_ID, COCO_BACKEND_URL, INGEST_SERVICE_TOKEN, OPENAI_API_KEY
   ```
4. Enable timers (agent service can be run manually):
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now coco-agent-scheduler.timer coco-heartbeat.timer coco-update.timer
   ```
5. Logs live in `/var/log/coco/agent.log`, `/var/log/coco/session-scheduler.log`, and `/var/log/coco/heartbeat.log`.

See `config/INSTALL.md` for manual install steps and `config/DEVICE_SPEC.md` for full runtime details.

## Running locally (dev)
```bash
git clone https://github.com/jh2k2/coco-hardware-scripts.git coco-device
cd coco-device
npm install
cp .env.example .env
COCO_AGENT_MODE=mock npm start   # mock mode avoids realtime audio keys/hardware
```
Realtime mode requires `COCO_AGENT_MODE=realtime`, `OPENAI_API_KEY`, and working ALSA devices.

## Tests
- Typecheck: `npm test` (tsc)
- Unit: `npm run test:unit`
- Backend smoke: `npm run test:mock-backend`

## Key configuration (see `.env.example`)
- Identity/backend: `COCO_DEVICE_ID`, `COCO_USER_EXTERNAL_ID`, `COCO_PARTICIPANT_ID`, `COCO_BACKEND_URL`, `INGEST_SERVICE_TOKEN` (or `COCO_BACKEND_API_KEY`).
- Agent/audio: `COCO_AGENT_MODE`, `OPENAI_API_KEY`, `OPENAI_OUTPUT_MODALITY`, `OPENAI_VOICE`, `REALTIME_MODEL`, `COCO_AUDIO_*`.
- Network resilience: `COCO_BACKEND_TIMEOUT_MS`, `COCO_BACKEND_RETRIES`, `COCO_EPHEMERAL_KEY_TIMEOUT_MS`.

## Updating on device
```bash
sudo /usr/local/bin/coco-update.sh
```
OTA: `coco-update.timer` runs daily at 02:30 with 15-minute jitter to pull the latest tag/branch, reinstall scripts/units, npm install, and restart services. Disable with `sudo systemctl disable --now coco-update.timer` if you need to pin a version.
