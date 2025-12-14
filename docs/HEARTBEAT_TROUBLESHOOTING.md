# Heartbeat Timer Troubleshooting

This document covers troubleshooting the CoCo device heartbeat system.

## Architecture

The heartbeat system consists of:

- **Timer**: `coco-heartbeat.timer` - Fires every 5 minutes
- **Service**: `coco-heartbeat.service` - Type=oneshot, no Restart=
- **Script**: `/usr/local/bin/coco-heartbeat.sh` - Sends heartbeat to backend

```
Timer (every 5 min)
    │
    ▼
Service (oneshot)
    │
    ▼
Script → Backend API
```

## Common Issues

### Issue: "Heartbeat stopped sending"

**Symptoms**: Backend shows device offline, but device has network connectivity.

**Diagnostic commands**:

```bash
# Check timer status
systemctl status coco-heartbeat.timer

# Check service status
systemctl status coco-heartbeat.service

# Check recent runs
journalctl -u coco-heartbeat.service --since "1 hour ago"

# Check heartbeat log file
tail -50 /var/log/coco/heartbeat.log

# Check last heartbeat payload
cat /tmp/coco-heartbeat-last.json
```

### Issue: Timer Fired But Service Didn't Run

**Possible causes**:

1. **Service blocked by systemd** - Check `systemctl status`
2. **network-online.target not satisfied** - WiFi not fully connected
3. **Script failing immediately** - Check logs

**Fix**:

```bash
# Reset any failed state
sudo systemctl reset-failed coco-heartbeat.service

# Restart the timer
sudo systemctl restart coco-heartbeat.timer

# Verify timer is active
systemctl list-timers | grep heartbeat
```

### Issue: Script Exits Non-Zero (Rare)

The heartbeat script should always exit 0. If not:

1. **Check .env file integrity**:
   ```bash
   cat /etc/coco/.env
   ```

2. **Check disk space**:
   ```bash
   df -h
   ```

3. **Check python3 availability**:
   ```bash
   which python3
   python3 --version
   ```

4. **Test the script manually**:
   ```bash
   sudo /usr/local/bin/coco-heartbeat.sh
   echo "Exit code: $?"
   ```

## Investigation: December 2025 Incident

### Report

Cofounder reported: "retried too many times then gave up and never started again"

- WiFi went down for ~11 hours
- Heartbeat stopped during outage
- Did NOT resume after WiFi came back
- Required manual reboot to fix

### Analysis

After thorough investigation:

1. **StartLimitBurst doesn't apply** - The service uses `Type=oneshot` with no `Restart=` directive. StartLimitBurst only affects auto-restart behavior.

2. **Script doesn't have `set -e`** - Only `set -o pipefail` is set. All error paths return 0.

3. **All error paths in script return 0** - The script never explicitly exits with non-zero.

4. **Timer should keep firing** - `OnUnitActiveSec=5min` schedules based on last activation.

### Likely Root Cause

Something external caused the script to fail or hang:

- **Corrupted .env file** - Network issues or Tailscale could have corrupted it
- **Disk full** - Can't write to log file
- **DNS resolution stuck** - WiFi came back but DNS was still broken
- **Tailscale network config** - Modified resolv.conf or routing

### Logs Needed to Confirm

Run these commands on the affected device:

```bash
# Check journal for heartbeat failures around the incident
journalctl -u coco-heartbeat.service --since "2025-12-11" --no-pager | head -100

# Check if service was ever rate-limited
journalctl | grep -i "start-limit\|rate-limit"

# Check the heartbeat log file
tail -200 /var/log/coco/heartbeat.log

# Check .env file integrity
cat /etc/coco/.env

# Check DNS resolution
nslookup coco-backend.fly.dev

# Check Tailscale status
tailscale status
```

## Script Behavior Reference

### Exit Codes

The heartbeat script always exits 0 because:

- No `set -e` in the script (only `pipefail`)
- All functions use `return` not `exit`
- Network failures are logged but don't cause non-zero exit

### Retry Logic

The script has built-in retries:

```bash
while [ $attempt -le 2 ]; do
  curl ...
  if [ $exit_code -eq 0 ] && [[ "$http_status" =~ ^2 ]]; then
    log "heartbeat sent (attempt $attempt, status $http_status)"
    success=0
    break
  else
    log "heartbeat attempt $attempt failed..."
    attempt=$((attempt + 1))
    sleep 2
  fi
done
if [ $success -ne 0 ]; then
  log "heartbeat failed after retries"
  # Note: Still returns 0!
fi
```

### Timer Configuration

```ini
[Timer]
OnBootSec=1min           # First run 1 minute after boot
OnUnitActiveSec=5min     # Then every 5 minutes
RandomizedDelaySec=60    # Add jitter up to 60 seconds
Persistent=true          # Catch up missed runs after downtime
```

## Prevention Recommendations

1. **Add explicit exit 0** at end of script (for clarity)
2. **Log script start/end** for easier debugging
3. **Add DNS check** before attempting backend call
4. **Monitor timer state** via backend (gap in heartbeats = issue)

## Quick Reference Commands

```bash
# Check everything
for svc in coco-heartbeat; do
  echo "=== $svc.service ==="
  systemctl status $svc.service
  echo "=== $svc.timer ==="
  systemctl status $svc.timer
done

# Force a heartbeat now
sudo systemctl start coco-heartbeat.service

# Watch heartbeat log
tail -f /var/log/coco/heartbeat.log

# Check network connectivity
curl -s -o /dev/null -w "%{http_code}" https://coco-backend.fly.dev/healthz
```
