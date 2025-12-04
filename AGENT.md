# Coco Agent Architecture

## Executive Summary

Coco is a voice-based cognitive coaching agent that runs structured 10-minute sessions with 6 activities designed to stimulate cognitive function.

## Current Architecture: Synchronous Pipeline (Recommended)

**Status: Active Development**

The sync pipeline (`src/syncSession.ts`) uses a simple, blocking architecture:

```
for each activity:
    audio = TTS(prompt)           # OpenAI TTS API
    playAudio(audio)              # aplay (blocking)
    recording = recordAudio()     # arecord + silence detection
    transcript = STT(recording)   # Whisper API
    response = LLM(context)       # GPT-4o-mini for contextual acks
```

**Run with:** `npm run start:sync`

**Features:**
- Contextual LLM responses (not generic acknowledgments)
- Conversation history across activities
- Personalized session closing
- Stop phrase detection
- No event soup, no race conditions, no phantom responses

**See:** [docs/SYNC_PIPELINE.md](docs/SYNC_PIPELINE.md) for full details.

---

## Legacy Architecture: Realtime API (Deprecated)

> **WARNING:** The Realtime-based architecture is fundamentally broken and should not be used for production. It is preserved here for reference only.

**Status: Deprecated**

The legacy architecture imposes a synchronous, turn-based model onto an asynchronous, event-driven API. This mismatch causes:
- `conversation_already_has_active_response` errors
- Ghost `history_added` events
- Phantom responses
- Dead periods and hangs

**This is not fixable with patches. Use the sync pipeline instead.**

---

## Legacy Documentation (Realtime API)

The following sections document the deprecated Realtime architecture for reference.

**Document Purpose:**
1. **Audit** what existed (Part 1-2)
2. **Specify** what a correct architecture would look like (Part 3)
3. **Define** the migration path (Part 4) - **COMPLETED: See sync pipeline**

---

## Part 1: Current Implementation

### 1.1 File Overview

| File | Lines | Purpose |
|------|-------|---------|
| `agent.ts` | 1874 | Main session orchestrator, all core components |
| `audioIO.ts` | 596 | ALSA audio binding, RMS-based VAD |
| `planner.ts` | 91 | Activity selection and plan building |
| `backend.ts` | 159 | Session summary submission |
| `tools.ts` | 61 | Agent tools (build_plan, telemetry, end_session) |
| `runAgent.ts` | 178 | Entry point, ephemeral key creation |
| `mockAgent.ts` | 559 | Mock mode for testing without OpenAI |
| `logger.ts` | 109 | Logging infrastructure |

### 1.2 The Core Contradiction

The activity loop assumes this sequence:
```
speak → playback idle → listen → transcript → next activity
```

The Realtime API does not guarantee this ordering:
- `response.done` fires when response generation completes, NOT when audio playback finishes
- `history_added` fires when an audio item is created, NOT when the user stops speaking
- `input_audio_transcription.completed` can arrive before, after, or never relative to `history_added`
- Events can arrive out of order, be duplicated, or be dropped

**The code assumes synchronous turns. The API is asynchronous. This causes:**
- `conversation_already_has_active_response` errors
- Ghost `history_added` events
- Dead periods where server expects input but code is waiting
- Responses interrupted mid-playback

**This is not fixable with patches. The procedural loop must be replaced.**

### 1.3 Session Flow

The main orchestrator is `startSession()` ([agent.ts:1011-1874](src/agent.ts#L1011-L1874)):

```
startSession(ephemeralKey)
│
├── CONNECTION PHASE (lines 1070-1310)
│   ├── Create RealtimeSession with config
│   ├── Connect with retry (3 attempts, exponential backoff: 1s, 2s, 4s)
│   ├── Wait for session.created (2s timeout)
│   ├── Send session.update to disable server VAD
│   ├── Wait for session.updated confirmation (3s timeout)
│   ├── Retry session.update if failed (2s timeout)
│   └── Exit early if DRY_RUN mode
│
├── INTRO PHASE (lines 1508-1600)
│   ├── sessionSay("Let's begin...")
│   ├── waitForPlaybackIdle()
│   ├── waitForParticipantExchange(8s window)
│   ├── Early exit if stop requested → send summary
│   └── handleNoInput() if no response
│
├── ACTIVITIES PHASE (lines 1610-1700)
│   └── for each activity in plan (6 activities):
│       ├── Check stopRequested at loop start
│       ├── sessionSay(activity prompt)
│       ├── waitForPlaybackIdle()
│       ├── waitForParticipantExchange(12-20s window)
│       ├── Capture transcript → participantUtterances[]
│       ├── handleNoInput() if no response
│       └── Early exit if stop requested → goodbye → summary
│
├── CLOSING PHASE (lines 1700-1750)
│   ├── sessionSay(closing remarks)
│   ├── waitForPlaybackIdle()
│   ├── waitForParticipantExchange(8s window)
│   └── Final goodbye message
│
└── SUMMARY PHASE (lines 1750-1800)
    ├── scoreSentimentFromTranscript() → GPT-4o-mini
    ├── Build SessionSummaryPayload
    ├── sendSessionSummary() with 5s timeout
    └── Return SessionResult
```

### 1.4 Components

#### startSession (Main Orchestrator)

Location: [agent.ts:1011-1874](src/agent.ts#L1011-L1874)

The main function that runs an entire coaching session. Creates all components, manages the session lifecycle, handles early exit, and ensures cleanup.

**Key responsibilities:**
- Connection and VAD configuration
- Phase orchestration (intro → activities → closing → summary)
- Stop detection coordination
- Error handling and cleanup in finally block

#### createAgent

Location: [agent.ts:997-1003](src/agent.ts#L997-L1003)

Creates the `RealtimeAgent` instance with system prompt and tools.

```typescript
export function createAgent() {
  return new RealtimeAgent({
    name: "Coco",
    instructions: systemPrompt,
    tools,
  });
}
```

#### ResponseTracker

Location: [agent.ts:185-308](src/agent.ts#L185-L308)

Attempts to track response lifecycles via event counting.

```typescript
type ResponseTracker = {
  waitForIdle: (timeoutMs?: number) => Promise<void>;
  cancelActive: () => void;
  trackResponse: (id: string) => void;
};
```

**How it works:**
- Increments counter on `response.created`
- Decrements on `response.done`, `response.failed`, `response.cancelled`
- Has 120s max lifetime timeout per response to prevent infinite hangs
- Listens via both direct events and `transport_event` wrapper

**Why it's broken:**
- Counter can desync if events are dropped or duplicated
- Based on event counting, not actual server state
- Cannot recover from desync without timeout

#### ServerPlaybackTracker

Location: [agent.ts:326-414](src/agent.ts#L326-L414)

Tracks server audio buffer state using authoritative events.

```typescript
type ServerPlaybackTracker = {
  isServerAudioActive: () => boolean;
  waitForServerIdle: (timeoutMs?: number) => Promise<void>;
  cleanup: () => void;
};
```

**How it works:**
- Listens for `output_audio_buffer.started` → server is streaming audio
- Listens for `output_audio_buffer.stopped` → server finished streaming
- Listens for `output_audio_buffer.cleared` → buffer was cleared (interrupt)
- `waitForPlaybackIdle()` waits for BOTH server idle AND local playback drain

**This is correct.** This component uses authoritative server signals.

#### SessionStopController

Location: [agent.ts:485-552](src/agent.ts#L485-L552)

Unified stop detection with atomic state transitions.

```typescript
export enum StopState {
  RUNNING = "running",
  STOP_PENDING = "stop_pending",
  GOODBYE_PLAYING = "goodbye_playing",
  STOPPED = "stopped",
}

export type SessionStopController = {
  requestStop: (source: StopSource, reason: string) => boolean;
  isStopRequested: () => boolean;
  hasGoodbyePlayed: () => boolean;
  markGoodbyePlaying: () => void;
  markStopped: () => void;
  getAbortSignal: () => AbortSignal;
  abort: () => void;
  getState: () => StopState;
  checkUserText: (text: string, source: StopSource) => boolean;
  checkAssistantText: (text: string) => boolean;
};
```

**Stop phrases detected:**

User stop phrases (triggers immediate stop):
```typescript
["stop session", "end session", "thank you", "thanks",
 "it's over", "its over", "that's all", "goodbye", "bye"]
```

Assistant goodbye phrases (marks goodbye as played):
```typescript
["take care", "goodbye", "good bye", "see you",
 "until next time", "thanks for spending time", "thank you for spending time"]
```

**This is correct.** This is a proper FSM with atomic transitions.

**Gaps:**
- Does not coordinate with ResponseTracker during stop
- Does not cancel timers in other subsystems
- Does not wait for in-flight transcriptions

#### waitForAgentTurn

Location: [agent.ts:554-618](src/agent.ts#L554-L618)

Waits for agent response to complete, including audio playback.

**How it works:**
- Waits for BOTH `response.done` AND `audio_done`/`response.output_audio.done`
- In TEXT_ONLY mode, only waits for `response.done`
- 90s default timeout
- Cleans up all listeners on completion or timeout

**This is better than just waiting for `response.done`**, but still doesn't use the authoritative `output_audio_buffer.stopped` signal.

#### sessionSay

Location: [agent.ts:620-825](src/agent.ts#L620-L825)

Delivers prompts to the agent with retry logic.

```typescript
type SayOptions = {
  timeoutMs?: number;      // Response timeout (default: 30s)
  abortSignal?: AbortSignal;
  force?: boolean;         // If true, ignore abort signal and deliver anyway
};
```

**Flow:**
1. Check abort signal (skip if aborted, unless `force: true`)
2. Wait for any active response (`waitForIdle`)
3. Cancel any stale response (`cancelActive`)
4. Clear input audio buffer
5. Set up lifecycle listeners BEFORE sending (prevents race)
6. Send `response.create` event
7. Wait for `response.created` → track response ID
8. Wait for `response.done` or failure
9. Retry up to 4x with exponential backoff (300ms, 600ms, 1200ms, 2400ms)

**Why it's broken:** Does not wait for `output_audio_buffer.stopped`. Audio may still be playing when function returns.

#### waitForParticipantExchange

Location: [agent.ts:828-982](src/agent.ts#L828-L982)

Listens for user speech during an activity.

```typescript
interface ParticipantResponse {
  responded: boolean;
  transcript: string | null;
}
```

**Flow:**
1. Enable VAD (clears mute window, starts speech detection)
2. Start timeout timer (configurable, 12-20s for activities)
3. Listen for `history_added` with `role=user`
4. On user message, wait up to 3s for `input_audio_transcription.completed`
5. Listen for transcripts via `transport_event` in parallel
6. Extend timer if user still speaking (up to 3 extensions of 10s each)
7. Check stopRequested every 100ms
8. Disable VAD when window ends
9. Return `{ responded, transcript }`

**Why it's broken:**
- `history_added` doesn't mean user finished speaking
- Transcript may never arrive; 3s is arbitrary
- No way to know when user turn is actually complete without server VAD

#### Audio Binding (VAD)

Location: [audioIO.ts:132-595](src/audioIO.ts#L132-L595)

RMS-based voice activity detection with ALSA audio.

**Implemented features:**
- Hysteresis: start threshold (800) > end threshold (600) to prevent flicker
- RMS smoothing: rolling 3-chunk average
- Pre-speech buffer: ~500ms lookback to capture speech onset
- Silence detection: 1.5s silence triggers commit
- Mute window: mute capture during playback (2s default)
- `clearMuteWindow()`: clears mute when entering listen phase
- Minimum speech duration: 300ms before committing

**Why it's broken:**
- RMS cannot distinguish speech from echo (no AEC)
- Static thresholds fail across environments
- No adaptive noise floor
- Mute window is a workaround, not echo cancellation

#### scoreSentimentFromTranscript

Location: [agent.ts:123-165](src/agent.ts#L123-L165)

Calls GPT-4o-mini to analyze sentiment from session transcript.

**Returns:**
```typescript
type SentimentSnapshot = {
  summary: string;  // "positive" | "neutral" | "negative"
  score: number;    // 0-100
};
```

#### handleNoInput

Location: [agent.ts:1049-1058](src/agent.ts#L1049-L1058) (nested in startSession)

Called when user doesn't respond during listen window.

```typescript
async function handleNoInput(context: "intro" | "step") {
  if (stopController.isStopRequested()) return;
  const message = context === "intro"
    ? "I didn't hear you yet, but you can jump in at any time."
    : "I didn't hear you that round, but I'll keep us moving.";
  await sessionSay(...);
  await waitForPlaybackIdle();
}
```

### 1.5 All Timers

| Timer | Location | Timeout | Purpose |
|-------|----------|---------|---------|
| Response lifecycle | 620 | 30s default | Wait for response.done |
| Response max lifetime | 295 | 120s | Auto-cleanup phantom responses |
| Agent turn | 596 | 90s | Wait for response + audio |
| Server playback idle | 389 | 10s | Wait for buffer.stopped |
| session.created wait | 1209 | 2s | Connection handshake |
| session.updated wait | 1221 | 3s | VAD disable confirmation |
| VAD retry wait | 1278 | 2s | Retry session.update |
| Listen window | 939 | 12-20s | Wait for user speech |
| Grace period | 944 | 2s | Delay before timer starts |
| Speech extension | 930 | 10s | Extend if still talking (3x max) |
| Transcript wait | 873 | 3s | Wait for transcription |
| Stop check interval | 974 | 100ms | Poll for stop request |
| Summary send | 1041 | 5s | Backend timeout |
| Auto-response wait | 1512 | 5s | Wait for SDK auto-response |
| Connection backoff | 1304 | 1s/2s/4s | Exponential retry |
| Local playback poll | audioIO | 50ms | Busy-wait for drain |

**Total: 16 independent timers with no central coordination.**

### 1.6 Configuration

#### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REALTIME_MODEL` | gpt-4o-realtime-preview-2024-12-17 | Model to use |
| `OPENAI_OUTPUT_MODALITY` | audio | "text" for text-only mode |
| `COCO_AUDIO_DISABLE` | 0 | "1" to disable audio |
| `COCO_DRY_RUN` | 0 | "1" to test connection only |
| `COCO_INTRO_RESPONSE_WINDOW_MS` | 8000 | Listen window after intro |
| `COCO_MIN_LISTEN_WINDOW_MS` | 12000 | Min listen window per activity |
| `COCO_MAX_LISTEN_WINDOW_MS` | 20000 | Max listen window per activity |
| `COCO_FINAL_RESPONSE_WINDOW_MS` | 8000 | Closing listen window |
| `COCO_LISTEN_GRACE_MS` | 2000 | Grace period before timer |
| `COCO_AUDIO_INPUT_DEVICE` | default | ALSA capture device |
| `COCO_AUDIO_OUTPUT_DEVICE` | default | ALSA playback device |
| `COCO_AUDIO_SAMPLE_RATE` | 24000 | Audio sample rate |
| `COCO_AUDIO_PLAYBACK_MUTE_MS` | 2000 | Mute during playback |
| `COCO_SPEECH_START_THRESHOLD` | 800 | RMS to start speech |
| `COCO_SPEECH_END_THRESHOLD` | 600 | RMS to end speech |
| `COCO_RMS_SMOOTHING_WINDOW` | 3 | Rolling average chunks |

#### Hardcoded Constants

| Constant | Value | Location |
|----------|-------|----------|
| `SILENCE_DURATION_MS` | 1500 | audioIO.ts:37 |
| `MIN_SPEECH_DURATION_MS` | 300 | audioIO.ts:38 |
| `PRE_SPEECH_BUFFER_SIZE` | 4 chunks | audioIO.ts:39 |
| `maxConnectRetries` | 3 | agent.ts:1162 |
| `MAX_SPEECH_EXTENSIONS` | 3 | agent.ts:918 |
| `SPEECH_EXTENSION_MS` | 10000 | agent.ts:919 |
| `TRANSCRIPT_WAIT_MS` | 3000 | agent.ts:860 |
| `RESPONSE_MAX_LIFETIME_MS` | 120000 | agent.ts:183 |

### 1.7 Tools

Defined in [tools.ts:27-61](src/tools.ts#L27-L61):

| Tool | Purpose |
|------|---------|
| `curriculum.build_plan` | Returns 6-activity session plan |
| `telemetry.log` | Records activity result/timing |
| `end_session` | Triggers graceful session end |

### 1.8 Session Result

```typescript
export interface SessionResult {
  utteranceCount: number;  // Number of user utterances captured
  durationSec: number;     // Total session duration
  sentiment: string;       // "positive" | "neutral" | "negative" | "early_exit" | "error_exit" | "dry_run"
}
```

**Exit codes** (from runAgent.ts):
| Code | Status | Meaning |
|------|--------|---------|
| 0 | success | Normal completion |
| 2 | unattended | No user input detected |
| 1 | error_exit | Session failed |

---

## Part 2: What the Code Assumes (Wrong)

```
┌─────────────────────────────────────────────────────────────────┐
│                    ASSUMED (WRONG) FLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   1. sessionSay()                                                │
│      └─ response.create ──────► Server generates response        │
│      └─ response.done ────────► ASSUMES: Audio finished playing  │
│                                 REALITY: Generation finished     │
│                                                                  │
│   2. waitForPlaybackIdle()                                       │
│      └─ ServerPlaybackTracker ► CORRECT: Uses buffer.stopped     │
│      └─ Local poll ───────────► Estimates remaining audio        │
│                                                                  │
│   3. waitForParticipantExchange()                                │
│      └─ history_added ────────► ASSUMES: User finished speaking  │
│                                 REALITY: Audio item created      │
│      └─ 3s transcript wait ───► ASSUMES: Transcript will arrive  │
│                                 REALITY: May never arrive        │
│                                                                  │
│   4. Next activity                                               │
│      └─ ASSUMES: Clean state                                     │
│      └─ REALITY: Ghost events, pending responses, stale timers   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 3: Correct Architecture (Specification)

This section specifies what a correct implementation must look like.

### 3.1 Event-Driven State Machine

The procedural loop must be replaced with a formal FSM.

```typescript
enum SessionState {
  DISCONNECTED,
  CONNECTING,
  CONFIGURING,           // Waiting for session.updated
  IDLE,                  // Ready for next action
  AGENT_RESPONDING,      // response.create sent
  AGENT_AUDIO_PLAYING,   // output_audio_buffer.started received
  AGENT_AUDIO_SETTLING,  // output_audio_buffer.stopped, local drain
  LISTENING,             // VAD enabled, waiting for user
  USER_SPEAKING,         // Speech detected
  PROCESSING_INPUT,      // input committed, waiting for transcript
  STOP_REQUESTED,        // Stop triggered
  GOODBYE_PLAYING,       // Final message playing
  CLOSING,
  CLOSED
}

interface StateTransition {
  from: SessionState;
  trigger: ServerEvent | InternalEvent;
  to: SessionState;
  guard?: () => boolean;
  action?: () => void;
}
```

**State transitions triggered by events, not by code flow assumptions.**

### 3.2 Authoritative Event Sources

| Signal | Source | Use |
|--------|--------|-----|
| Response started | `response.created` | Enter AGENT_RESPONDING |
| Audio streaming | `output_audio_buffer.started` | Enter AGENT_AUDIO_PLAYING |
| Audio complete | `output_audio_buffer.stopped` | Enter AGENT_AUDIO_SETTLING |
| User turn started | `input_audio_buffer.speech_started` | Enter USER_SPEAKING |
| User turn ended | `input_audio_buffer.speech_stopped` | Commit audio |
| Transcript ready | `input_audio_transcription.completed` | Process transcript |
| Response complete | `response.done` | (informational only) |

**`response.done` is NOT used for flow control. Only buffer events are authoritative.**

### 3.3 Timer Coordinator

All timers must be managed centrally:

```typescript
interface TimerCoordinator {
  schedule(name: string, ms: number, callback: () => void): TimerId;
  cancel(name: string): void;
  cancelAll(): void;
  onStateChange(newState: SessionState): void;
}

const TIMER_CANCELLATION_RULES: Record<SessionState, string[]> = {
  [SessionState.AGENT_RESPONDING]: ['listen_window', 'transcript_wait'],
  [SessionState.LISTENING]: ['response_idle', 'playback_settle'],
  [SessionState.STOP_REQUESTED]: ['*'],  // Cancel all
};
```

### 3.4 VAD Requirements

RMS-based VAD must be replaced. Options:

**Option A: Server VAD with response suppression**
- Enable `turn_detection: { type: "server_vad", create_response: false }`
- Server detects speech boundaries
- Client controls when to trigger response

**Option B: WebRTC VAD + AEC**
- Use WebRTC's VAD for speech detection
- Use WebRTC's AEC for echo cancellation

**Option C: Hardware AEC**
- USB speakerphone with built-in AEC

**RMS-only VAD is not an option. It cannot work reliably.**

### 3.5 Turn Management Rules

1. **Agent turn ends when:** `output_audio_buffer.stopped` AND local playback drained
2. **User turn starts when:** VAD detects speech (with AEC active)
3. **User turn ends when:** Configurable silence duration (user-specific)
4. **Transcript is ready when:** `input_audio_transcription.completed`

**Do not use `history_added` for turn boundaries.**

---

## Part 4: Migration Path

### Phase 1: Foundation

1. **Implement TimerCoordinator** - Central timer management with state-based cancellation
2. **Implement SessionState FSM** - Replace procedural flow with state machine
3. **Fix sessionSay** - Wait for `output_audio_buffer.stopped` not `response.done`

### Phase 2: VAD Replacement

4. **Integrate WebRTC VAD** or enable server VAD with response suppression
5. **Fix waitForParticipantExchange** - Use proper turn signals, remove `history_added` dependency

### Phase 3: Cleanup

6. **Remove ResponseTracker** - Replace with FSM state
7. **Consolidate event handlers** - Single event dispatcher through FSM

---

## Part 5: Error Handling

### Retry Logic

| Error | Handling |
|-------|----------|
| `conversation_already_has_active_response` | Wait for idle, retry |
| Response timeout | Retry with backoff (4 attempts, 300-2400ms) |
| Connection failure | Retry with backoff (3 attempts, 1-4s) |
| `session.update` failure | Retry once (2s timeout) |

### Ignored Errors

| Error Code | Reason |
|------------|--------|
| `input_audio_buffer_commit_empty` | Expected when buffer already processed |
| `response_cancel_not_active` | Harmless race condition |

---

## Part 6: Cleanup

The finally block ([agent.ts:1800-1874](src/agent.ts#L1800-L1874)) ensures:

1. Stop audio binding
2. Clean up ServerPlaybackTracker
3. Clear end_session callback
4. Remove all event listeners (history, transport_event)
5. Interrupt and close session
6. Send fallback summary if not already sent

---

## Changelog

### 2025-12-04 - Document Accuracy Update

- Added complete function inventory from agent.ts
- Added session flow diagram with line numbers
- Added all 16 timers with locations
- Fixed line number references
- Added tools, session result, exit codes
- Added scoreSentimentFromTranscript, handleNoInput
- Added stop phrases lists

### 2025-12-03 - Code Changes

- Added `ServerPlaybackTracker` using authoritative buffer events
- Added `SessionStopController` FSM
- Added 120s response timeout
- Added VAD hysteresis and smoothing
- Added `clearMuteWindow()`

### What Still Needs to Change

- [ ] Implement TimerCoordinator
- [ ] Implement full SessionState FSM
- [ ] Replace RMS VAD with WebRTC VAD + AEC
- [ ] Fix sessionSay to wait for output_audio_buffer.stopped

---

## Part 7: VAD Experiments and Failures (2025-12-04)

This section documents the attempts to fix turn detection and their outcomes.

### 7.1 Branch Overview

| Branch | Approach | Status |
|--------|----------|--------|
| `feature/manual-vad` | Manual VAD with `turn_detection: null` | Fails - phantom responses, timing issues |
| `feature/server-vad` | Server VAD with `create_response: true` | Fails - agent talks to itself |
| `main` | Original implementation | Broken - same core issues |

### 7.2 Approach 1: Manual VAD (`feature/manual-vad`)

**Strategy:**
- Set `turn_detection: null` to disable server VAD
- Use RMS-based VAD to detect speech start/end
- Manually call `input_audio_buffer.commit` when silence detected
- Manually control when to call `response.create`

**Implementation:**
- audioIO.ts: RMS speech detection with hysteresis (start=800, end=600)
- audioIO.ts: Silence callback triggers `input_audio_buffer.commit`
- agent.ts: `waitForParticipantExchange` listens for `history_added` with `role=user`
- agent.ts: Cancel auto-responses during listen window (intro only)

**Problems Encountered:**

1. **Phantom Responses**
   - Responses created that we didn't trigger with `response.create`
   - Response completes in 76ms (empty/phantom)
   - Timer resets incorrectly
   ```
   [13:12:23.336] Speech started
   [13:12:23.536] response.created (WHO CREATED THIS?)
   [13:12:23.612] response.done (76ms - phantom)
   ```

2. **`turn_detection: null` API Bugs**
   - [OpenAI Community: turn_detection null breaks manual audio control](https://community.openai.com/t/turn-detection-null-breaks-manual-audio-control-in-realtime-api-web-rtc/1146451)
   - API behavior is unstable/inconsistent
   - Sometimes doesn't respond at all
   - Sometimes auto-responds when it shouldn't

3. **Multi-turn Conversation Failure**
   - During activities, user speaks → agent should respond → user responds again
   - But: either we cancel all auto-responses (no conversation) or allow them (chaos)
   - Exit listen window too early when transcript arrives
   - Agent moves to next activity before conversation completes

4. **RMS VAD Limitations**
   - Cannot distinguish speech from echo (no AEC)
   - Static thresholds fail across environments
   - Mute window is a workaround, not echo cancellation

### 7.3 Approach 2: Server VAD (`feature/server-vad`)

**Strategy:**
- Enable `turn_detection: { type: "server_vad", create_response: true }`
- Let server detect when user stops speaking
- Let server auto-commit audio and auto-create responses
- Remove manual VAD logic
- Work WITH auto-responses instead of fighting them

**Implementation:**
- agent.ts: Session config with `turn_detection.type = "server_vad"`
- agent.ts: Session update requires `type: "realtime"` field
- agent.ts: Wait for `session.updated` confirmation
- agent.ts: `waitForParticipantExchange` tracks multi-turn conversation
- agent.ts: 8s inactivity timeout ends conversation naturally
- audioIO.ts: Simplified - just streams audio, no VAD

**Problems Encountered:**

1. **Session Update Format**
   - First error: `Missing required parameter: 'session.type'`
   - Had to add `type: "realtime"` inside session object
   - OpenAI API documentation unclear on exact format

2. **Active Response Conflicts**
   - Error: `conversation_already_has_active_response`
   - With `create_response: true`, server auto-creates responses
   - Our `sessionSay` tries to create response → conflict
   - Retry logic eventually succeeds, but creates chaos

3. **Agent Talks to Itself**
   - Server VAD may trigger on ambient noise or echo
   - Even with mute during playback, timing issues cause false triggers
   - Agent responds to its own output as if user spoke
   - Creates infinite loop of self-conversation

4. **Loss of Control**
   - With `create_response: true`, we can't control what agent says
   - Activity prompts get mixed with auto-responses
   - Structured curriculum flow breaks down
   - No way to inject specific activity instructions

### 7.4 Core Issues (Both Approaches Fail)

1. **No Echo Cancellation**
   - Hardware doesn't have AEC
   - Software AEC not implemented
   - Agent hears its own output as "user speech"
   - Both manual and server VAD trigger on echo

2. **Async vs Sync Mismatch**
   - Code assumes synchronous turn-taking
   - API is fully asynchronous
   - Events arrive out of order
   - Cannot reliably sequence: speak → wait → listen → respond

3. **OpenAI SDK Abstractions**
   - SDK may have internal auto-response logic
   - `sendAudio()` behavior unclear
   - Transport layer events not fully documented
   - Can't easily disable all auto-behavior

4. **No Authoritative Turn Boundary**
   - `response.done` ≠ audio finished playing
   - `history_added` ≠ user finished speaking
   - `input_audio_transcription.completed` may never arrive
   - Only `output_audio_buffer.stopped` is reliable (for agent turn)

### 7.5 Current State of Code

**`feature/server-vad` branch (current):**
```typescript
// agent.ts session config
session.transport.sendEvent({
  type: "session.update",
  session: {
    type: "realtime",
    input_audio_transcription: { model: "whisper-1" },
    turn_detection: {
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 700,
      create_response: true,
    },
  },
});

// waitForParticipantExchange
- Tracks userMessageCount and agentResponseCount
- 8s inactivity timeout
- Waits for response.done to reset activity timer
- Returns true if any user messages received
```

**`feature/manual-vad` branch (stashed):**
```typescript
// agent.ts session config
turn_detection: null  // Disable server VAD

// audioIO.ts
- RMS-based speech detection
- Hysteresis thresholds (800/600)
- Silence callback → input_audio_buffer.commit
- Pre-speech buffer (~500ms)
- Mute window during playback

// waitForParticipantExchange
- cancelAutoResponses parameter
- Cancel auto-responses during intro only
- Allow auto-responses during activities
- Multi-turn conversation support
- Track agentResponseInProgress
```

### 7.6 What Needs to Happen

**Fundamental Requirements:**

1. **Echo Cancellation** - Cannot work without it
   - Option A: Hardware AEC (USB speakerphone)
   - Option B: WebRTC AEC (complex integration)
   - Option C: Full-duplex headset (user wears headphones)

2. **Choose One VAD Approach** - Stop trying to do both
   - If manual: Fix `turn_detection: null` issues, implement proper AEC
   - If server: Accept loss of control, redesign activity flow

3. **Proper State Machine** - Replace procedural loop
   - Event-driven FSM as specified in Part 3
   - Central timer coordinator
   - Single source of truth for session state

4. **API Stability** - Report bugs, wait for fixes
   - `turn_detection: null` has known issues
   - Server VAD behavior inconsistent
   - May need to wait for OpenAI to fix their API

### 7.7 Recommended Next Steps

1. **Stop iterating on broken foundation** - Both approaches have fundamental issues
2. **Get hardware AEC** - USB speakerphone with built-in echo cancellation
3. **Test with headphones** - Eliminate echo to isolate other issues
4. **Implement FSM** - Replace procedural code with event-driven state machine
5. **Consider text mode** - For now, text-only mode may be only reliable option
