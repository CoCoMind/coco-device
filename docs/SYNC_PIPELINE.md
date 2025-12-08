# Synchronous Pipeline

## Status: Production Ready ✅

The synchronous TTS + STT + LLM pipeline is complete and deployed.

## Quick Start

```bash
npm run start:sync
```

## Why This Exists

The Realtime API architecture was fundamentally broken for Coco's use case:

1. **Async/Sync Mismatch** - Coco needs deterministic turn-taking; Realtime is event-driven chaos
2. **No Echo Cancellation** - RMS VAD can't distinguish speech from echo on open speakers
3. **16 Independent Timers** - Symptom of fighting the abstraction
4. **Phantom Responses** - Events arrive out of order, get dropped, or duplicate

Coco's actual requirements (structured 10-minute sessions with clear turn boundaries) map perfectly to a synchronous pipeline.

## Architecture

```
for each activity:
    audio = TTS(prompt)           # OpenAI TTS API, blocking
    playAudio(audio)              # aplay, blocking
    recording = recordAudio()     # arecord + silence detection, blocking
    transcript = STT(recording)   # Whisper API, blocking
    response = LLM(context)       # GPT-4o-mini for contextual responses
```

No events. No FSM. No race conditions.

## Features

| Feature | Status |
|---------|--------|
| TTS (OpenAI) | ✅ |
| Playback (aplay) | ✅ |
| Recording + silence detection | ✅ |
| STT (Whisper) | ✅ |
| Planner integration | ✅ |
| Stop phrase detection | ✅ |
| LLM contextual responses | ✅ |
| Conversation history | ✅ |
| Personalized closing | ✅ |

## Session Flow

```
[INTRO]
COCO: "Hello! I'm Coco, your cognitive companion..."

[ACTIVITY 1-5]
COCO: {activity prompt from curriculum}
USER: {response}
COCO: {LLM-generated contextual acknowledgment}

[ACTIVITY 6 / CLOSING]
COCO: {activity prompt}
USER: {response}
COCO: {LLM-generated personalized closing referencing session highlights}
```

## Timing

| Phase | Typical Time |
|-------|--------------|
| TTS | 1-4s |
| Playback | 2-7s |
| Recording | 5-60s (dynamic) |
| STT | 1-5s |
| LLM | 1-2s |

**Total per turn:** ~15-25s (acceptable for 10-minute session)

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `COCO_AUDIO_OUTPUT_DEVICE` | pulse | ALSA output device |
| `COCO_AUDIO_INPUT_DEVICE` | pulse | ALSA input device |
| `COCO_AUDIO_DISABLE` | 0 | Set to 1 to disable audio |

## Files

| File | Purpose |
|------|---------|
| `src/syncSession.ts` | Main sync session runner |
| `src/planner.ts` | Activity selection |
| `src/backend.ts` | Session summary submission |
| `docs/SYNC_PIPELINE.md` | This document |

## Migration Status

### Phase 1: Core Pipeline ✅
- [x] TTS → Play → Record → STT pipeline
- [x] Run 6 activities back-to-back
- [x] Integrate with planner
- [x] Stop phrase detection

### Phase 2: LLM Brain ✅
- [x] Chat Completions for contextual responses
- [x] Conversation history across activities
- [x] Personalized session closing
- [x] Handle "no response" gracefully

### Phase 3: Production Hardening ✅
- [x] Backend integration (session summaries)
- [x] Systemd service integration (`coco-native-agent-boot.sh` → `npm run start:sync`)
- [x] Multi-turn conversation within activities
- [x] Session status tracking (success/unattended/early_exit)

### Phase 4: Cleanup ✅
- [x] Realtime code marked as deprecated in AGENT.md
- [x] Updated systemd boot script
- [x] Documentation updated

## Changelog

### 2025-12-08 (v0.1.6 - Pilot Reliability Fixes)

**Security:**
- Removed embedded SSH private key from provision-device.sh
- Per-device key generation with manual GitHub deploy key setup
- Fixed log permissions (0644 → 0600) to prevent secrets exposure

**Reliability:**
- Added retry/timeout to all OpenAI API calls (TTS, STT, LLM)
- 30s timeout + 2 retries for transient network failures (configurable)
- Extracted withRetry utility to `src/retry.ts` with 19 unit tests

**OTA Updates:**
- Added automatic rollback on failed updates
- Health check verifies: entry point exists, package.json valid, node_modules present, TypeScript compiles
- Rollback restores previous commit + reinstalls deps

### 2025-12-05 (v0.1.3 - OTA Reliability & Health Check)
- Fixed coco-update.sh annotated tag handling (filter `^{}` suffix)
- Added ref validation before destructive git operations
- Added `die()` helper for clean error exits with logging
- Logs previous/new commit hashes for rollback tracking
- Service restart failures now logged individually
- New `npm run health` command for comprehensive device diagnostics
- Health check validates: env, files, deps, systemd, network, audio, TypeScript

### 2025-12-05 (v0.1.2 - UX Improvements)
- Dynamic recording: 30s initial cap, extends to 60s if user still speaking
- Fixed followUp=true always includes question (MAY → MUST)
- Fixed last turn handling: no question asked on final turn
- Fixed unattended sessions now send summary to backend
- Readiness check with 3 attempts before marking unattended
- Retry prompts when user not heard (up to 2 retries per turn)

### 2025-12-04 (Phase 3 & 4 - Production Ready)
- Re-enabled backend integration with proper SessionSummaryPayload
- Updated systemd boot script to use `npm run start:sync`
- Added device_id, participant_id, user_external_id to payload
- Session status tracking (success/unattended/early_exit)
- Exit code 2 for unattended sessions
- Marked Realtime code as deprecated in AGENT.md
- Fixed activity scripts (memory_strength_phrase, attention_story_match)
- Fixed LLM acknowledgments to not ask questions when moving on

### 2024-12-04 (Phase 2)
- Added LLM brain with GPT-4o-mini
- Contextual acknowledgments based on user responses
- Conversation history maintained across activities
- Personalized closing that references session highlights
- Removed syncPoc.ts (replaced by syncSession.ts)

### 2024-12-04 (Phase 1)
- Created syncSession.ts with full 6-activity session
- Integrated with planner (buildPlan())
- Added stop phrase detection
- Tested: Full sessions completing successfully
