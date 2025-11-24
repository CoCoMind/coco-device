import { spawn, ChildProcess } from "node:child_process";
import { RealtimeSession } from "@openai/agents/realtime";

const SAMPLE_RATE = Number(process.env.COCO_AUDIO_SAMPLE_RATE ?? "24000");
const CHANNELS = Number(process.env.COCO_AUDIO_CHANNELS ?? "1");
const SAMPLE_FORMAT = process.env.COCO_AUDIO_SAMPLE_FORMAT ?? "S16_LE";
const OUTPUT_DEVICE = process.env.COCO_AUDIO_OUTPUT_DEVICE ?? "pulse";
const INPUT_DEVICE = process.env.COCO_AUDIO_INPUT_DEVICE ?? "pulse";

export const ALSA_SAMPLE_RATE = SAMPLE_RATE;

type AudioBinding = {
  start(): void;
  stop(): void;
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

  const audioHandler = (event: { data?: ArrayBuffer }) => {
    if (!event?.data) {
      return;
    }
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
    if (playbackBackpressure) {
      return;
    }
    const chunk = Buffer.from(event.data);
    try {
      const ok = stdin.write(chunk);
      if (!ok) {
        playbackBackpressure = true;
        stdin.once("drain", () => {
          playbackBackpressure = false;
        });
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
        playback = safeSpawn(
          "aplay",
          "aplay",
          playbackArgs,
          { stdio: ["pipe", "ignore", "inherit"] },
        );
        playbackBackpressure = false;
        const playbackStdin = playback?.stdin;
        if (playbackStdin) {
          playbackStdin.setMaxListeners?.(0);
          playbackStdin.on("error", (error: NodeJS.ErrnoException) => {
            if (error?.code !== "EPIPE") {
              console.error("[alsa] playback stdin error:", error);
            }
          });
        }
      }
      if (playback && !listenerAttached) {
        emitter.on("audio", audioHandler);
        listenerAttached = true;
      }

      if (!capture) {
        capture = safeSpawn(
          "arecord",
          "arecord",
          captureArgs,
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        capture?.stdout?.on("data", (chunk: Buffer) => {
          try {
            session.sendAudio(bufferToArrayBuffer(chunk));
          } catch (error) {
            console.error("[alsa] Failed to send microphone audio:", error);
          }
        });
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
      if (listenerAttached) {
        if (typeof emitter.off === "function") {
          emitter.off("audio", audioHandler);
        } else if (typeof emitter.removeListener === "function") {
          emitter.removeListener("audio", audioHandler);
        }
        listenerAttached = false;
      }
    },
  };
}
