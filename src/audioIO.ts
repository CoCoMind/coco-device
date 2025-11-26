import { spawn, ChildProcess } from "node:child_process";
import { RealtimeSession } from "@openai/agents/realtime";
import log from "./logger";

const MAX_SAMPLE_RATE = 24000;
const SAMPLE_RATE = (() => {
  const raw = Number(process.env.COCO_AUDIO_SAMPLE_RATE ?? "24000");
  if (!Number.isFinite(raw) || raw <= 0) {
    log.warn("audio", `Invalid COCO_AUDIO_SAMPLE_RATE="${process.env.COCO_AUDIO_SAMPLE_RATE}"; defaulting to ${MAX_SAMPLE_RATE}`);
    return MAX_SAMPLE_RATE;
  }
  if (raw > MAX_SAMPLE_RATE) {
    log.warn("audio", `COCO_AUDIO_SAMPLE_RATE=${raw} exceeds realtime max of ${MAX_SAMPLE_RATE}; clamping`);
    return MAX_SAMPLE_RATE;
  }
  return raw;
})();
const CHANNELS = Number(process.env.COCO_AUDIO_CHANNELS ?? "1");
const SAMPLE_FORMAT = process.env.COCO_AUDIO_SAMPLE_FORMAT ?? "S16_LE";
const OUTPUT_DEVICE = process.env.COCO_AUDIO_OUTPUT_DEVICE ?? "pulse";
const INPUT_DEVICE_RAW = process.env.COCO_AUDIO_INPUT_DEVICE;
const INPUT_DEVICE = INPUT_DEVICE_RAW ?? "pulse";
const CAPTURE_DISABLED =
  INPUT_DEVICE_RAW === "" || process.env.COCO_AUDIO_INPUT_DISABLE === "1";
const PLAYBACK_MUTE_MS = Number(
  process.env.COCO_AUDIO_PLAYBACK_MUTE_MS ?? "1500",
);

export const ALSA_SAMPLE_RATE = SAMPLE_RATE;

type AudioBinding = {
  start(): void;
  stop(): void;
  stopCapture(): void;
  waitForPlaybackIdle?: (maxWaitMs?: number) => Promise<void>;
};

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  const view = new Uint8Array(arrayBuffer);
  view.set(buffer);
  return arrayBuffer;
}

function safeSpawn(
  label: string,
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess | null {
  try {
    const proc = spawn(command, args, options);
    proc.on("error", (error) => {
      log.error("audio", `${label} process error`, error);
    });
    return proc;
  } catch (error) {
    log.error("audio", `Failed to start ${label} (${command})`, error);
    return null;
  }
}

export function createAlsaAudioBinding(session: RealtimeSession): AudioBinding {
  if (process.platform !== "linux") {
    log.debug("audio", "Not on Linux, skipping ALSA audio binding");
    return { start() {}, stop() {}, stopCapture() {} };
  }

  const transport: unknown = session.transport;
  if (!transport || typeof (transport as { on: unknown }).on !== "function") {
    log.warn("audio", "Realtime transport does not expose event hooks; skipping audio binding");
    return { start() {}, stop() {}, stopCapture() {} };
  }

  type TransportEmitter = {
    on: (event: string, listener: (...args: any[]) => void) => void;
    off?: (event: string, listener: (...args: any[]) => void) => void;
    removeListener?: (event: string, listener: (...args: any[]) => void) => void;
  };

  const emitter = transport as TransportEmitter;

  let playback: ChildProcess | null = null;
  let capture: ChildProcess | null = null;
  let listenerAttached = false;
  let playbackBackpressure = false;
  const playbackQueue: Buffer[] = [];
  let muteCaptureUntil = 0;
  let pendingPlaybackMs = 0;
  const bytesPerSample = SAMPLE_FORMAT.includes("8") ? 1 : 2;
  const bytesPerSecond = SAMPLE_RATE * CHANNELS * bytesPerSample;
  const playbackLagFloorMs = 150;

  const playbackArgs = [
    "-t",
    "raw",
    "-f",
    SAMPLE_FORMAT,
    "-c",
    String(CHANNELS),
    "-r",
    String(SAMPLE_RATE),
    "-q",
    "-D",
    OUTPUT_DEVICE,
    "-",
  ];

  const captureArgs = [
    "-t",
    "raw",
    "-f",
    SAMPLE_FORMAT,
    "-c",
    String(CHANNELS),
    "-r",
    String(SAMPLE_RATE),
    "-q",
    "-D",
    INPUT_DEVICE,
    "-",
  ];

  const flushPlaybackQueue = () => {
    const current = playback;
    const stdin = current?.stdin;
    if (
      !current ||
      !stdin ||
      current.killed ||
      stdin.destroyed ||
      !stdin.writable
    ) {
      playbackQueue.length = 0;
      playbackBackpressure = false;
      return;
    }
    playbackBackpressure = false;
    while (playbackQueue.length) {
      const next = playbackQueue.shift();
      if (!next) {
        continue;
      }
      const ok = stdin.write(next);
      if (!ok) {
        playbackBackpressure = true;
        stdin.once("drain", flushPlaybackQueue);
        break;
      }
    }
  };

  const audioHandler = (event: { data?: ArrayBuffer }) => {
    if (!event?.data) {
      return;
    }
    muteCaptureUntil = Date.now() + PLAYBACK_MUTE_MS;
    const currentPlayback = playback;
    const stdin = currentPlayback?.stdin;
    if (
      !currentPlayback ||
      !stdin ||
      currentPlayback.killed ||
      stdin.destroyed ||
      !stdin.writable
    ) {
      return;
    }
    const chunk = Buffer.from(event.data);
    try {
      if (bytesPerSecond > 0) {
        const chunkMs = Math.round((chunk.length / bytesPerSecond) * 1000);
        if (chunkMs > 0) {
          pendingPlaybackMs = Math.min(
            pendingPlaybackMs + chunkMs,
            PLAYBACK_MUTE_MS + 10_000,
          );
          setTimeout(() => {
            pendingPlaybackMs = Math.max(0, pendingPlaybackMs - chunkMs);
          }, chunkMs).unref?.();
        }
      }
      if (playbackBackpressure) {
        playbackQueue.push(chunk);
        return;
      }
      const ok = stdin.write(chunk);
      if (!ok) {
        playbackBackpressure = true;
        playbackQueue.push(chunk);
        stdin.once("drain", flushPlaybackQueue);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== "EPIPE") {
        log.error("audio", "Failed to stream playback audio", err);
      }
    }
  };

  return {
    start() {
      log.audio("Starting audio binding", {
        outputDevice: OUTPUT_DEVICE,
        inputDevice: INPUT_DEVICE,
        sampleRate: SAMPLE_RATE,
        captureDisabled: CAPTURE_DISABLED,
      });

      if (!playback) {
        log.debug("audio", `Starting playback: aplay -D ${OUTPUT_DEVICE}`);
        playback = safeSpawn("aplay", "aplay", playbackArgs, {
          stdio: ["pipe", "ignore", "inherit"],
        });
        playbackBackpressure = false;
        playbackQueue.length = 0;
        pendingPlaybackMs = 0;
        const playbackStdin = playback?.stdin;
        if (playback && playbackStdin) {
          playbackStdin.setMaxListeners?.(0);
          playbackStdin.on("error", (error: NodeJS.ErrnoException) => {
            if (error?.code !== "EPIPE") {
              log.error("audio", "Playback stdin error", error);
            }
          });
          log.info("audio", "✓ Playback (aplay) started");
        } else if (!playback) {
          log.warn("audio", "Playback unavailable; skipping audio output");
        }
      }
      if (playback && !listenerAttached) {
        emitter.on("audio", audioHandler);
        listenerAttached = true;
      }

      if (!capture && !CAPTURE_DISABLED) {
        log.debug("audio", `Starting capture: arecord -D ${INPUT_DEVICE}`);
        capture = safeSpawn("arecord", "arecord", captureArgs, {
          stdio: ["ignore", "pipe", "inherit"],
        });
        if (!capture) {
          log.warn("audio", "Microphone capture unavailable; participant speech will be skipped");
        } else {
          log.info("audio", "✓ Capture (arecord) started");
          let captureChunkCount = 0;
          let audioSentCount = 0;
          let lastLogTime = 0;
          capture.stdout?.on("data", (chunk: Buffer) => {
            captureChunkCount++;
            const now = Date.now();
            const isMuted = now < muteCaptureUntil;

            // Log every 5 seconds to show capture is active
            if (now - lastLogTime > 5000) {
              const muteRemaining = Math.max(0, muteCaptureUntil - now);
              log.audio(`Capture stats: ${captureChunkCount} chunks received, ${audioSentCount} sent to API, mute=${muteRemaining}ms`);
              lastLogTime = now;
            }

            if (isMuted) {
              return; // Muted during playback
            }

            try {
              session.sendAudio(bufferToArrayBuffer(chunk));
              audioSentCount++;
            } catch (error) {
              log.error("audio", "Failed to send microphone audio", error);
            }
          });
          capture.on("error", (err) => {
            log.error("audio", "Capture process error", err);
          });
          capture.on("exit", (code) => {
            log.warn("audio", `Capture process exited with code ${code}`);
          });
        }
      } else if (CAPTURE_DISABLED) {
        log.info("audio", "Capture disabled by configuration");
      }
    },
    stopCapture() {
      if (capture && !capture.killed) {
        log.audio("Stopping capture only (keeping playback)");
        capture.stdout?.removeAllListeners("data");
        capture.kill("SIGTERM");
        capture = null;
        log.debug("audio", "Capture stopped");
      }
    },
    stop() {
      log.audio("Stopping audio binding");
      if (capture && !capture.killed) {
        capture.stdout?.removeAllListeners("data");
        capture.kill("SIGTERM");
        log.debug("audio", "Capture stopped");
      }
      if (playback && !playback.killed) {
        if (playback.stdin && playback.stdin.writable) {
          playback.stdin.end();
        }
        playback.kill("SIGTERM");
        log.debug("audio", "Playback stopped");
      }
      capture = null;
      playback = null;
      playbackBackpressure = false;
      playbackQueue.length = 0;
      pendingPlaybackMs = 0;
      if (listenerAttached) {
        if (typeof emitter.off === "function") {
          emitter.off("audio", audioHandler);
        } else if (typeof emitter.removeListener === "function") {
          emitter.removeListener("audio", audioHandler);
        }
        listenerAttached = false;
      }
      log.audio("Audio binding stopped");
    },
    async waitForPlaybackIdle(maxWaitMs: number = 5_000) {
      const start = Date.now();
      while (pendingPlaybackMs > playbackLagFloorMs) {
        if (Date.now() - start > maxWaitMs) {
          log.debug("audio", `waitForPlaybackIdle timed out after ${maxWaitMs}ms`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}
