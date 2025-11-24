# Coco Device

Hardware-ready Raspberry Pi build for the Coco voice agent, including systemd units, Wi-Fi provisioning, heartbeat, scheduled sessions, and realtime agent code.

## Quick start
1) Flash Raspberry Pi OS Lite and enable SSH.
2) On the Pi, run the bootstrap:
```bash
curl -sSL https://raw.githubusercontent.com/jh2k2/coco-hardware-scripts/main/install.sh | sudo bash
```
3) Copy `.env.example` to `.env` in `/home/pi/coco-device` (or your user) and fill in IDs/tokens.
4) Insert USB with `wifi.conf` (or use Ethernet) and reboot.

Details: see `config/INSTALL.md` and `config/DEVICE_SPEC.md`.
