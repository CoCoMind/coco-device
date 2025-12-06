# Coco Agent Architecture

## Overview

Coco is a voice-based cognitive coaching agent that runs structured 10-minute sessions with 6 activities designed to stimulate cognitive function.

## Architecture: Synchronous Pipeline

The sync pipeline (`src/syncSession.ts`) uses a simple, blocking architecture:

```
for each activity:
    audio = TTS(prompt)           # OpenAI TTS API
    playAudio(audio)              # aplay (blocking)
    recording = recordAudio()     # arecord + silence detection
    transcript = STT(recording)   # Whisper API
    response = LLM(context)       # GPT-4o-mini for contextual acks
```

**Run with:** `npm run start` or `npm run start:sync`

## Features

- Full 6-activity session support
- Contextual LLM responses (not generic acknowledgments)
- Conversation history across activities
- Personalized session closing
- Stop phrase detection
- Session status tracking (success/unattended/early_exit)

## File Structure

| File | Purpose |
|------|---------|
| `src/syncSession.ts` | Main session runner |
| `src/planner.ts` | Activity selection and plan building |
| `src/backend.ts` | Session summary submission to backend |
| `config/curriculum/activities.json` | Activity definitions |

## Session Flow

```
[INTRO]
COCO: "Hello! I'm Coco, your cognitive companion..."

[ACTIVITY 1-5]
COCO: {activity prompt from curriculum}
USER: {response}
COCO: {LLM-generated contextual acknowledgment}

[ACTIVITY 6 / CLOSING]
COCO: {closing question}
USER: {response}
COCO: {LLM-generated personalized closing referencing session highlights}
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `COCO_AUDIO_OUTPUT_DEVICE` | pulse | ALSA output device |
| `COCO_AUDIO_INPUT_DEVICE` | pulse | ALSA input device |
| `COCO_AUDIO_DISABLE` | 0 | Set to 1 to disable audio (dry-run mode) |
| `COCO_DEVICE_ID` | hostname | Device identifier |
| `COCO_PARTICIPANT_ID` | - | Participant identifier |
| `COCO_USER_EXTERNAL_ID` | participant_id | User external identifier |

## Exit Codes

| Code | Status | Meaning |
|------|--------|---------|
| 0 | success | Normal completion with user participation |
| 2 | unattended | Session completed but no user input detected |
| 1 | error | Session failed with error |

## Session Summary

After each session, a summary is sent to the backend including:
- Session ID and plan ID
- Device and participant identifiers
- Start/end timestamps and duration
- Turn count (number of user responses)
- Session status (success/unattended/early_exit)
- Sentiment summary and score

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run start` | Run a session |
| `npm run start:sync` | Run a session (alias) |
| `npm run test` | Run all tests |
| `npm run typecheck` | TypeScript type checking |

## Systemd Integration

The session is started via `scripts/coco-native-agent-boot.sh` which:
1. Acquires a lock to prevent concurrent sessions
2. Loads environment from `.env`
3. Runs `npm run start:sync`
4. Records session timestamp on success

See `scripts/run-scheduled-session.sh` for the scheduler that handles network checking and session status tracking.
