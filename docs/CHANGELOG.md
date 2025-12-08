# Changelog

All notable changes to the Coco Device software.

---

## v0.1.6 (2025-12-08) - Pilot Reliability Fixes

### Security
- Removed embedded SSH private key from provision-device.sh
- Per-device key generation with manual GitHub deploy key setup
- Fixed log permissions (0644 → 0600) to prevent secrets exposure

### Reliability
- Added retry/timeout to all OpenAI API calls (TTS, STT, LLM)
- 30s timeout + 2 retries for transient network failures (configurable)
- Extracted withRetry utility to `src/retry.ts` with 19 unit tests

### OTA Updates
- Added automatic rollback on failed updates
- Health check verifies: entry point exists, package.json valid, node_modules present, TypeScript compiles
- Rollback restores previous commit + reinstalls deps

---

## v0.1.5 (2025-12-07) - OTA Stability

- Fixed service restart behavior during OTA updates
- Don't restart coco-agent.service during updates (avoids interrupting sessions)

---

## v0.1.4 (2025-12-06) - WiFi Provisioning

- Added Comitup captive portal for WiFi provisioning
- Device creates CoCo-XXXX hotspot when no WiFi available
- Automatic fallback to hotspot if WiFi lost

---

## v0.1.3 (2025-12-05) - OTA Reliability & Health Check

- Fixed coco-update.sh annotated tag handling (filter `^{}` suffix)
- Added ref validation before destructive git operations
- Added `die()` helper for clean error exits with logging
- Logs previous/new commit hashes for rollback tracking
- Service restart failures now logged individually
- New `npm run health` command for comprehensive device diagnostics
- Health check validates: env, files, deps, systemd, network, audio, TypeScript

---

## v0.1.2 (2025-12-05) - UX Improvements

- Dynamic recording: 30s initial cap, extends to 60s if user still speaking
- Fixed followUp=true always includes question (MAY → MUST)
- Fixed last turn handling: no question asked on final turn
- Fixed unattended sessions now send summary to backend
- Readiness check with 3 attempts before marking unattended
- Retry prompts when user not heard (up to 2 retries per turn)

---

## v0.1.1 (2025-12-04) - Production Hardening

- Re-enabled backend integration with proper SessionSummaryPayload
- Updated systemd boot script to use `npm run start:sync`
- Added device_id, participant_id, user_external_id to payload
- Session status tracking (success/unattended/early_exit)
- Exit code 2 for unattended sessions
- Marked Realtime code as deprecated
- Fixed activity scripts (memory_strength_phrase, attention_story_match)
- Fixed LLM acknowledgments to not ask questions when moving on

---

## v0.1.0 (2025-12-04) - Initial Sync Pipeline

### Architecture
- Synchronous TTS → Play → Record → STT → LLM pipeline
- Full 6-activity session support
- Planner integration for activity selection
- Stop phrase detection ("goodbye", "bye", etc.)

### Features
- LLM brain with GPT-4o-mini for contextual responses
- Conversation history across activities
- Personalized session closing referencing highlights
- Backend session summary submission
