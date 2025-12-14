# CoCo Device Error Handling

This document describes the error handling architecture in the CoCo device agent.

## Session Exit Codes

| Code | Status | Meaning |
|------|--------|---------|
| 0 | success | Session completed with user engagement |
| 1 | failed | Session crashed (error reported to backend) |
| 2 | unattended | No user present or heard |
| 3 | early_exit | User said stop phrase |

## Error Flow Architecture

All async errors in the session runner bubble up to the main try/catch block:

```
runSession()
    ├── textToSpeech() → TTS errors
    ├── playAudio()    → EPIPE, audio device errors
    ├── recordAudio()  → Device disconnect, stream errors
    └── transcribe()   → STT errors
           │
           ▼
    main() try/catch
           │
           ▼
    sendSessionStartFailed() → Report to backend
           │
           ▼
    process.exit(1)
```

## Audio Error Handling (v0.1.10)

### The safeReject Pattern

Both `playAudio()` and `recordAudio()` use the `safeReject` pattern to handle stream errors:

```typescript
let rejected = false;
const safeReject = (err: Error) => {
  if (!rejected) {
    rejected = true;
    reject(err);
  }
};

aplay.on("error", safeReject);
aplay.stdin.on("error", safeReject);  // Catches EPIPE

aplay.on("exit", (code) => {
  if (rejected) return;  // Already rejected via error handler
  // ... normal handling
});
```

**Why this pattern?**

1. **Prevents double-rejection**: Both `stdin.on('error')` and `process.on('exit')` can fire for the same failure
2. **Catches EPIPE**: When audio device is unavailable, `aplay` exits immediately and `stdin.write()` throws EPIPE
3. **Ensures cleanup**: All error paths flow to the same reject handler

### playAudio() Error Handling

Handles errors when playing audio via `aplay`:

- `aplay.on("error")` - Process spawn failures
- `aplay.stdin.on("error")` - EPIPE when audio device unavailable
- Try/catch around `stdin.write()` - Synchronous write errors

### recordAudio() Error Handling

Handles errors when recording via `arecord`:

- `arecord.on("error")` - Process spawn failures
- `arecord.stdout.on("error")` - Device disconnect during recording
- Timer cleanup in error handler

## Known Error Types

| Error | Cause | Resolution |
|-------|-------|------------|
| EPIPE on aplay | Audio device missing/unplugged | Check USB audio connection, run `aplay -l` |
| ENODEV on arecord | Microphone disconnected | Check USB audio connection, run `arecord -l` |
| TTS timeout | Network issues | Check internet connectivity |
| STT timeout | Network issues | Check internet connectivity |
| TTS arrayBuffer failed | Response parsing issue | Usually network-related, retried automatically |
| WAV file creation failed | Memory/SDK issue | Check available memory |

## Backend Error Reporting

When a session fails (exit code 1), `sendSessionStartFailed()` is called with:

```typescript
{
  device_id: string,      // Device identifier
  participant_id?: string, // Participant if known
  error_type: string,     // e.g., "Error", "EPIPE"
  error_message: string,  // Full error message
  timestamp: string       // ISO timestamp
}
```

This allows the backend to track device failures and identify patterns.

## Testing Error Handling

Run the error handling tests:

```bash
npx tsx tests/errorHandling.test.ts
```

Test with missing audio device:

```bash
COCO_AUDIO_OUTPUT_DEVICE=nonexistent \
COCO_MAX_SESSION_MS=10000 \
timeout 30 npx dotenv -- tsx src/syncSession.ts

# Should:
# 1. Exit with code 1
# 2. Log "FATAL: Session crashed"
# 3. Send session_start_failed to backend
```

## Debugging Tips

1. **Check audio devices**: `aplay -l` and `arecord -l`
2. **Check logs**: `/var/log/coco/agent.log`
3. **Run manually**: `npx dotenv -- tsx src/syncSession.ts`
4. **Disable audio for testing**: `COCO_AUDIO_DISABLE=1`
