import { spawn, ChildProcess } from "node:child_process";
import { RealtimeSession } from "@openai/agents/realtime";

const MAX_SAMPLE_RATE = 24000;
const SAMPLE_RATE = (() => {
  const raw = Number(process.env.COCO_AUDIO_SAMPLE_RATE ?? "24000");
  if (!Number.isFinite(raw) || raw <= 0) {
    console.warn(
      `[alsa] Invalid COCO_AUDIO_SAMPLE_RATE="${process.env.COCO_AUDIO_SAMPLE_RATE}"; defaulting to ${MAX_SAMPLE_RATE}.`,
    );
    return MAX_SAMPLE_RATE;
  }
  if (raw > MAX_SAMPLE_RATE) {
    console.warn(
      `[alsa] COCO_AUDIO_SAMPLE_RATE=${raw} exceeds realtime max of ${MAX_SAMPLE_RATE}; clamping.`,
    );
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
      console.error(`[alsa] ${label} process error:`, error);
    });
    return proc;
  } catch (error) {
    console.error(`[alsa] Failed to start ${label} (${command}):`, error);
    return null;
  }
}

export function createAlsaAudioBinding(session: RealtimeSession): AudioBinding {
  if (process.platform !== "linux") {
    return { start() {}, stop() {} };
  }

  const transport: unknown = session.transport;
  if (!transport || typeof (transport as { on: unknown }).on !== "function") {
    console.warn("[alsa] Realtime transport does not expose event hooks; skipping audio binding.");
    return { start() {}, stop() {} };
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
        console.error("[alsa] Failed to stream playback audio:", err);
      }
    }
  };

  return {
    start() {
      if (!playback) {
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
              console.error("[alsa] playback stdin error:", error);
            }
          });
        } else if (!playback) {
          console.warn("[alsa] playback unavailable; skipping audio output.");
        }
      }
      if (playback && !listenerAttached) {
        emitter.on("audio", audioHandler);
        listenerAttached = true;
      }

      if (!capture && !CAPTURE_DISABLED) {
        capture = safeSpawn("arecord", "arecord", captureArgs, {
          stdio: ["ignore", "pipe", "inherit"],
        });
        if (!capture) {
          console.warn(
            "[alsa] Microphone capture unavailable; participant speech will be skipped.",
          );
        } else {
          capture.stdout?.on("data", (chunk: Buffer) => {
            if (Date.now() < muteCaptureUntil) {
              return;
            }
            try {
              session.sendAudio(bufferToArrayBuffer(chunk));
            } catch (error) {
              console.error("[alsa] Failed to send microphone audio:", error);
            }
          });
        }
      }
    },
    stop() {
      if (capture && !capture.killed) {
        capture.stdout?.removeAllListeners("data");
        capture.kill("SIGTERM");
      }
      if (playback && !playback.killed) {
        if (playback.stdin && playback.stdin.writable) {
          playback.stdin.end();
        }
        playback.kill("SIGTERM");
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
    },
    async waitForPlaybackIdle(maxWaitMs: number = 5_000) {
      const start = Date.now();
      while (pendingPlaybackMs > playbackLagFloorMs) {
        if (Date.now() - start > maxWaitMs) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}
