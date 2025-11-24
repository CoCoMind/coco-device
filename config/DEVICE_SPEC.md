# Coco Device Runtime Specification (Raspberry Pi)

## Device Overview
- Purpose: run the Coco cognitive coaching agent with realtime speech I/O, collect sentiment and session metadata, and send structured summaries to the backend.
- Identity: configured via `.env` (`COCO_USER_EXTERNAL_ID`, `COCO_PARTICIPANT_ID`, `COCO_DEVICE_ID`) and backend URL/token (`COCO_BACKEND_URL`, `INGEST_SERVICE_TOKEN`) at `~/coco-device/.env`.
- Agent entrypoint: `/usr/local/bin/coco-native-agent-boot.sh` → `npm start` in `~/coco-device` (`COCO_AGENT_MODE` defaults to `mock` unless overridden).

## Boot & Autostart
- `coco-agent.service` (`/etc/systemd/system/coco-agent.service`) starts the agent on boot after network-online; restarts on failure with 5s backoff.
- Wi-Fi provisioning loop starts on boot via `wifi-provision.service` and continuously watches for USB-based Wi-Fi credentials.
- Twice-daily scheduled sessions run via `coco-agent-scheduler.timer` at 09:00 and 15:00 (`coco-agent-scheduler.service` → `scripts/run-scheduled-session.sh`).
- Heartbeats: `coco-heartbeat.timer` (every 5 minutes with 60s jitter, persistent) triggers `coco-heartbeat.service` which runs `/usr/local/bin/coco-heartbeat.sh` as the install user (default `pi`) to POST `/internal/heartbeat`; runs even if agent/network are unhealthy.

## Wi-Fi Provisioning (USB → wpa_supplicant)
- Daemon: `/usr/local/bin/wifi-provision.sh`, managed by `wifi-provision.service` (Wants network-pre; loops every `LOOP_DELAY_SECONDS`, default 15s).
- Watches USB mounts (`/media`, `/run/media`, `/mnt` plus detected USB roots) for `wifi.conf`.
- `wifi.conf` keys: `ssid`, `psk` (optional), `hidden` (1/true/yes), `priority`.
- Flow: disable existing SSID entry, add/select new network via `wpa_cli`, set SSID/PSK/hidden/priority, wait up to `CONNECT_TIMEOUT_SECONDS` (default 45s) for connection. On success, rename to `.applied-<timestamp>` and save config; on failure, rename to `.failed-<timestamp>`, restore previous network if disabled.
- UX: logs to `/var/log/coco/wifi-provision.log`; announces USB presence/no-conf/connect/fail via `espeak`→`aplay` (or `pico2wave`→`aplay`) on `AUDIO_DEVICE` (default `plughw:3,0`); logs if TTS unavailable. Stores last SSID in `/var/lib/wifi-provision/last-connected-ssid`.

## Scheduled Session Runner
- Timer → oneshot service: `coco-agent-scheduler.timer` (09:00, 15:00, persistent) triggers `coco-agent-scheduler.service` which runs `scripts/run-scheduled-session.sh` as the install user.
- Concurrency: `flock` lock at `/tmp/coco-session-runner.lock` prevents overlaps.
- Network gating: probes `https://www.google.com/generate_204`, falls back to `ping 1.1.1.1`; retries up to `MAX_NETWORK_ATTEMPTS` (default 12) with `NETWORK_RETRY_SECONDS` (default 300s). Skips session if still offline.
- Command: `${SESSION_CMD:-/usr/local/bin/coco-native-agent-boot.sh}` (overrideable); loads `.env` if present.
- Logging: appends to `/var/log/coco/session-scheduler.log` with start/end timestamps, status, duration_seconds, sentiment_summary snapshot; includes agent stdout/stderr.

## Agent Runtime (Realtime path)
- Entrypoint `src/runAgent.ts` → `startSession` (`src/agent.ts`); default model `gpt-4o-mini-realtime-preview-2024-12-17` unless `REALTIME_MODEL` set.
- Capabilities:
  - Speech synthesis: Realtime responses with `OPENAI_VOICE` (default `verse`); text-only if `OPENAI_OUTPUT_MODALITY=text`.
  - Speech recognition: ALSA PCM capture/playback via `arecord`/`aplay` (`src/audioIO.ts`), rate default 24000 Hz, mono, `S16_LE`.
  - Conversation: system prompt enforces 6-step ~10-minute curriculum; uses tool `curriculum.build_plan` sourced from `src/content/activities.json`.
  - Sentiment: post-run transcript scored via Responses API (`gpt-4o-mini` default) when `OPENAI_API_KEY` present; fallback sentinel if no speech.
  - Telemetry: `sendSessionSummary` posts to `{COCO_BACKEND_URL}/internal/ingest/session_summary` with bearer `INGEST_SERVICE_TOKEN`/`COCO_BACKEND_API_KEY`; payload includes IDs, duration, turn_count, sentiment.
- Resilience: turn and listen timeouts; transport interrupt after each turn; runs even without participant audio (still posts summary).
- Mock mode: `src/mockAgent.ts` for offline synthesis/mic capture, logs to `agent-activity.log`, still posts summary.

## Network & UX Behaviors
- Wi-Fi provisioning announces USB/no-conf/connect/fail; marks configs `.applied`/`.failed` to avoid repeated attempts; keeps previous network alive on failure.
- Agent service depends on `network-online.target`; scheduler retries connectivity before session.
- Audio stack assumes ALSA; Pulse connection failures may appear in logs on headless runs.

## Backend Integration
- Endpoint: `POST /internal/ingest/session_summary` on `COCO_BACKEND_URL` with bearer token.
- Payload: `session_id`, `plan_id`, `user_external_id`, `participant_id`, `device_id`, `label`, `started_at`, `ended_at`, `duration_seconds`, `turn_count`, `sentiment_summary`, `sentiment_score`, optional `notes`.
- Telemetry tool stub logs JSON to stdout; can be replaced in code for richer sinks (not modified on device).
- Heartbeat: `/usr/local/bin/coco-heartbeat.sh` builds the authoritative JSON (`device_id`, `agent_version`, `connectivity`, network block with `interface`/`ip`/`signal_rssi`/`latency_ms`, `agent_status`, `last_session_at`) and posts to `{COCO_BACKEND_URL}/internal/heartbeat` with bearer `INGEST_SERVICE_TOKEN`; retries once and logs to `/var/log/coco/heartbeat.log`.

## Heartbeat Details
- Config sources: `.env` (`COCO_DEVICE_ID`, `COCO_BACKEND_URL`, `INGEST_SERVICE_TOKEN`) and `/etc/coco-agent-version` (string version). Missing fields log “missing config” and still emit a degraded/crashed heartbeat; POST is skipped only if URL/token absent.
- Connectivity detection: `wifi` if `wlan0` has IP (RSSI via `iw dev wlan0 link`), `lte` if `wwan0`/`usb0` has IP, else `offline`; latency via `curl https://www.google.com/generate_204` (ms rounded).
- Agent status mapping: `systemctl is-active coco-agent.service` → `ok`/`degraded`/`crashed` per active/activating|deactivating/failed/other.
- State files: `/var/lib/coco/last_session_at` (updated by scheduler), `/var/log/coco/heartbeat.log` (install user, 644), `/etc/coco-agent-version` (e.g., `0.3.2`).
- Systemd: `coco-heartbeat.service` oneshot as install user; `coco-heartbeat.timer` `OnBootSec=1min`, `OnUnitActiveSec=5min`, `RandomizedDelaySec=60`, `Persistent=true`.

## Configuration Surface (env)
- Core: `OPENAI_API_KEY`/`OPENAI_EPHEMERAL_KEY`, `COCO_AGENT_MODE`, `COCO_BACKEND_URL`, `INGEST_SERVICE_TOKEN`, IDs (`COCO_USER_EXTERNAL_ID`, `COCO_PARTICIPANT_ID`, `COCO_DEVICE_ID`), `OPENAI_OUTPUT_MODALITY`, `OPENAI_VOICE`, `REALTIME_MODEL`.
- Audio: `COCO_AUDIO_SAMPLE_RATE`, `COCO_AUDIO_CHANNELS`, `COCO_AUDIO_SAMPLE_FORMAT`, `COCO_AUDIO_INPUT_DEVICE`, `COCO_AUDIO_OUTPUT_DEVICE`.
- Scheduler: `NETWORK_RETRY_SECONDS`, `MAX_NETWORK_ATTEMPTS`, `SESSION_CMD`, `LOG_FILE`, `LOCK_FILE`.
- Wi-Fi provisioning: `WLAN_IFACE`, `LOOP_DELAY_SECONDS`, `CONNECT_TIMEOUT_SECONDS`, `AUDIO_DEVICE` (overrideable via systemd drop-ins).

## Safety & Guardrails
- Non-overlapping scheduled runs via `flock`; services restart on failure (`Restart=always` for Wi-Fi, `Restart=on-failure` for agent).
- Network gating prevents offline scheduled sessions; Wi-Fi provisioning restores prior network on new-credential failure and tags bad configs.
- Voice UX optional; logs warn if TTS unavailable; device keeps running.
- Agent prompt enforces supportive, concise interaction and honors “skip”/fatigue cues; sentiment scoring is best-effort.
