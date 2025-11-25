# Coco Device Headless Test Plan (MVP v0)

Goal: Validate all device subsystems without real speaker/mic I/O or realtime WS audio. Manual-only items remaining: physical speaker output and live arecord/aplay loop with OpenAI Realtime.

## Conventions
- Repo: `~/coco-device`
- Temp assets: `~/coco-device/tests-temp/`
- Run as the install user unless noted. Use `sudo` where required.
- Set `COCO_AGENT_MODE=mock` for headless agent runs.

## 0) Prep
```bash
cd ~/coco-device
mkdir -p tests-temp/{logs,backend,bin,usb,usb2}
export COCO_REPO_DIR=~/coco-device
export COCO_RUN_USER=$USER
export COCO_AGENT_MODE=mock
```

## 1) Systemd / Boot Flow
- Verify units:
  ```bash
  systemctl status coco-agent.service           # manual-only; expected inactive
  systemctl status coco-agent-scheduler.timer  # enabled/active
  systemctl status coco-heartbeat.timer        # enabled/active
  systemctl status wifi-provision.service      # enabled/active
  ```
- Env/version load:
  ```bash
  sudo cat /etc/coco-agent-version
  sudo -u $USER bash -c 'cd ~/coco-device && . ./.env && echo $COCO_DEVICE_ID'
  ```
- Agent double-start guard:
  ```bash
  sudo systemctl start coco-agent.service
  sudo systemctl start coco-agent.service    # second start should no-op quickly
  sudo tail -n 40 /var/log/coco/agent.log
  ```
- Scheduler vs agent concurrency:
  ```bash
  # Start a scheduler run with a sleep-wrapped session command to hold the lock
  SESSION_CMD="/bin/sh -c 'sleep 10'" ./scripts/run-scheduled-session.sh &
  sleep 2
  sudo systemctl start coco-agent.service    # should be blocked by lockfile
  wait
  grep -E "already running|lock" /var/log/coco/session-scheduler.log
  ```

## 2) Wi-Fi Provisioning (Mocked)
- Mock wpa_cli/iwgetid to avoid real Wi-Fi:
  ```bash
  cat > tests-temp/bin/wpa_cli <<'SH'
  #!/usr/bin/env bash
  echo "network id/ssid/BSSID/flags"
  echo "0\tTestSSID\tany\t[CURRENT]"
  case "$1" in
    add_network) echo 1;;
    set_network) exit 0;;
    enable_network|select_network|reassociate|disable_network|remove_network|save_config) exit 0;;
    status) echo -e "wpa_state=COMPLETED\nssid=TestSSID";;
    list_networks) echo -e "0\tTestSSID\tany\t[CURRENT]";;
    *) exit 0;;
  esac
  SH
  cat > tests-temp/bin/iwgetid <<'SH'
  #!/usr/bin/env bash
  echo "TestSSID"
  SH
  chmod +x tests-temp/bin/*
  export PATH="$PWD/tests-temp/bin:$PATH"
  ```
- Valid wifi.conf:
  ```bash
  cat > tests-temp/usb/wifi.conf <<'EOF'
  ssid=ValidSSID
  psk=goodpass
  hidden=0
  priority=1
  EOF
  sudo LOG_FILE=/var/log/coco/wifi-provision.log USB_SEARCH_PATHS="tests-temp/usb" WLAN_IFACE=wlan0 CONNECT_TIMEOUT_SECONDS=3 ./scripts/wifi-provision.sh &
  sleep 5; pkill -f wifi-provision.sh
  ls tests-temp/usb | grep applied
  sudo cat /var/lib/wifi-provision/last-connected-ssid
  sudo tail -n 50 /var/log/coco/wifi-provision.log
  ```
- Invalid wifi.conf (force wpa_cli fail):
  ```bash
  mv tests-temp/bin/wpa_cli tests-temp/bin/wpa_cli.ok
  cat > tests-temp/bin/wpa_cli <<'SH'
  #!/usr/bin/env bash
  exit 1
  SH
  chmod +x tests-temp/bin/wpa_cli
  cat > tests-temp/usb2/wifi.conf <<'EOF'
  ssid=BadSSID
  psk=badpass
  EOF
  sudo LOG_FILE=/var/log/coco/wifi-provision.log USB_SEARCH_PATHS="tests-temp/usb2" CONNECT_TIMEOUT_SECONDS=2 ./scripts/wifi-provision.sh &
  sleep 5; pkill -f wifi-provision.sh
  ls tests-temp/usb2 | grep failed
  sudo tail -n 50 /var/log/coco/wifi-provision.log
  ```

## 3) Scheduler
- Offline gating:
  ```bash
  cat > tests-temp/bin/curl <<'SH'
  #!/usr/bin/env bash
  exit 28   # timeout
  SH
  cat > tests-temp/bin/ping <<'SH'
  #!/usr/bin/env bash
  exit 1
  SH
  chmod +x tests-temp/bin/{curl,ping}
  PATH="$PWD/tests-temp/bin:$PATH" LOG_FILE=/var/log/coco/session-scheduler.log CONNECTIVITY_PROBE=https://bad ./scripts/run-scheduled-session.sh
  grep "session will be skipped" /var/log/coco/session-scheduler.log
  ```
- Online run + lock:
  ```bash
  cat > tests-temp/bin/curl <<'SH'
  #!/usr/bin/env bash
  echo 204
  exit 0
  SH
  cat > tests-temp/bin/ping <<'SH'
  #!/usr/bin/env bash
  exit 0
  SH
  chmod +x tests-temp/bin/{curl,ping}
  PATH="$PWD/tests-temp/bin:$PATH" SESSION_CMD=/bin/true ./scripts/run-scheduled-session.sh
  sudo cat /var/lib/coco/last_session_at
  # Immediate rerun to hit lock
  PATH="$PWD/tests-temp/bin:$PATH" SESSION_CMD=/bin/true ./scripts/run-scheduled-session.sh
  grep "already running" /var/log/coco/session-scheduler.log
  ```

## 4) Agent (Mock Mode, Summary Validation)
- Run mock session headless:
  ```bash
  export COCO_AGENT_MODE=mock
  /usr/local/bin/coco-native-agent-boot.sh
  ```
  Expect exit 0, agent.log/session-scheduler.log entries, last_session_at updated.
- Validate summary fields (requires mock backend in section 5):
  Inspect mock backend log for fields: session_id, plan_id, started_at, ended_at, duration_seconds, turn_count, sentiment_summary, sentiment_score, device_id/user/participant/label, notes (optional). Confirm plan ran all steps (turn_count >= number of plan steps).

## 5) Mock Backend (Session + Heartbeat)
- Start mock backend:
  ```bash
  cat > tests-temp/backend/mock-backend.py <<'PY'
  from http.server import BaseHTTPRequestHandler, HTTPServer
  import json, sys
  class H(BaseHTTPRequestHandler):
      def do_POST(self):
          length = int(self.headers.get('content-length',0))
          body = self.rfile.read(length).decode()
          print(self.path, body, file=sys.stderr, flush=True)
          self.send_response(200); self.end_headers()
  HTTPServer(('0.0.0.0', 8081), H).serve_forever()
  PY
  python3 tests-temp/backend/mock-backend.py 2>tests-temp/backend/requests.log &
  MOCKPID=$!
  export COCO_BACKEND_URL=http://127.0.0.1:8081
  export INGEST_SERVICE_TOKEN=token
  export COCO_DEVICE_ID=testdev
  export COCO_USER_EXTERNAL_ID=u1
  export COCO_PARTICIPANT_ID=p1
  export OPENAI_API_KEY=dummy
  SESSION_CMD="/usr/bin/env COCO_BACKEND_URL=$COCO_BACKEND_URL INGEST_SERVICE_TOKEN=$INGEST_SERVICE_TOKEN COCO_AGENT_MODE=mock /usr/local/bin/coco-native-agent-boot.sh" ./scripts/run-scheduled-session.sh
  sudo -u $USER ./scripts/coco-heartbeat.sh
  kill $MOCKPID
  cat tests-temp/backend/requests.log
  ```
  Expectations: POSTs to `/internal/ingest/session_summary` and `/internal/heartbeat` with well-formed JSON.
- Failure path: restart mock backend to return 500 or stop it to observe retry/fail logs.

## 6) Heartbeat Degraded-Mode Cases
- Missing version:
  ```bash
  sudo mv /etc/coco-agent-version /etc/coco-agent-version.bak
  sudo -u $USER ./scripts/coco-heartbeat.sh
  sudo mv /etc/coco-agent-version.bak /etc/coco-agent-version
  grep "missing config" /var/log/coco/heartbeat.log | tail -n 5
  ```
- Missing last_session_at:
  ```bash
  sudo rm -f /var/lib/coco/last_session_at
  sudo -u $USER ./scripts/coco-heartbeat.sh
  grep "last_session_at" /var/log/coco/heartbeat.log | tail -n 5
  ```
- Backend unreachable:
  ```bash
  COCO_BACKEND_URL=http://127.0.0.1:65500 INGEST_SERVICE_TOKEN=token COCO_DEVICE_ID=testdev sudo -u $USER ./scripts/coco-heartbeat.sh
  grep "heartbeat failed" /var/log/coco/heartbeat.log | tail -n 5
  ```
- Agent inactive unexpectedly: stop service if running, run heartbeat, check agent_status reported as ok/inactive.

## 7) Logging & Filesystem Sanity (incl. growth)
- Check dirs/files:
  ```bash
  test -d /var/log/coco && test -d /var/lib/coco && test -d /var/lib/wifi-provision
  ls -l /var/log/coco
  sudo stat /etc/coco-agent-version
  ```
- Log growth: run 3–5 mock sessions (boot script or scheduler) and ensure logs append/readable:
  ```bash
  for i in 1 2 3; do COCO_AGENT_MODE=mock /usr/local/bin/coco-native-agent-boot.sh; done
  tail -n 100 /var/log/coco/agent.log
  tail -n 100 /var/log/coco/session-scheduler.log
  ```

## Expected Outcomes (Pass Criteria)
- Systemd: timers active; agent inactive by default; lockfile blocks concurrent runs.
- Wi-Fi: valid → .applied, state/logs updated; invalid → .failed, logs show error.
- Scheduler: offline → skip; online → success; lock prevents overlap; last_session_at updated on success.
- Agent mock: completes plan; exit 0; logs present; last_session_at updated when invoked via boot script.
- Summary payload: contains IDs, timestamps, duration, turn_count, sentiment fields, label/notes; plan not silently skipped.
- Backend: mock receives well-formed JSON for session and heartbeat; failure logged/retried.
- Heartbeat: correct metadata; degraded modes log missing config/last_session/backend issues; agent status reported appropriately.
- Logging/FS: all logs under /var/log/coco; state dirs exist; logs append across runs without corruption.
