/**
 * Audio storage module - handles local recording storage and upload queue.
 *
 * Local storage: SQLite database + FLAC-encoded audio files
 * Remote storage: Upload to backend (which stores in R2 + Neon)
 */

import Database from "better-sqlite3";
import {
  mkdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import logger from "./logger";
import { uploadAudioRecording } from "./backend";

// Configuration
const STORAGE_DIR = process.env.COCO_AUDIO_STORAGE_DIR ?? "/var/lib/coco";
const UPLOAD_ENABLED = process.env.COCO_AUDIO_UPLOAD_ENABLED !== "0";
const RETENTION_DAYS = Number(process.env.COCO_AUDIO_RETENTION_DAYS) || 7;
const MAX_UPLOAD_ATTEMPTS = 5;

// Audio constants (match syncSession.ts)
const SAMPLE_RATE = 24000;
const CHANNELS = 1;

// Types
export interface RecordingMetadata {
  sessionId: string;
  deviceId: string;
  participantId?: string;
  turnNumber: number;
  activityId?: string;
  durationMs: number;
  role: "user" | "assistant";
  transcript?: string;
}

export interface Recording {
  id: string;
  session_id: string;
  device_id: string;
  participant_id: string | null;
  turn_number: number;
  role: string;
  activity_id: string | null;
  duration_ms: number;
  file_size_bytes: number;
  file_path: string;
  sha256: string | null;
  transcript: string | null;
  upload_status: string;
  upload_attempts: number;
  recorded_at: string;
}

// SQLite schema
const SCHEMA = `
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  participant_id TEXT,
  turn_number INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  activity_id TEXT,
  duration_ms INTEGER NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  codec TEXT DEFAULT 'flac',
  sample_rate INTEGER DEFAULT 24000,
  channels INTEGER DEFAULT 1,
  file_path TEXT NOT NULL,
  sha256 TEXT,
  transcript TEXT,
  upload_status TEXT DEFAULT 'pending',
  upload_attempts INTEGER DEFAULT 0,
  last_attempt_at TEXT,
  remote_url TEXT,
  uploaded_at TEXT,
  delete_after_utc TEXT,
  recorded_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_upload_queue ON recordings(upload_status, upload_attempts);
CREATE INDEX IF NOT EXISTS idx_session ON recordings(session_id);
CREATE INDEX IF NOT EXISTS idx_cleanup ON recordings(delete_after_utc);
`;

// Database instance (lazy initialized)
let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const dbPath = join(STORAGE_DIR, "audio.db");
    mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
  }
  return db;
}

// Encode PCM buffer to FLAC using ffmpeg
async function encodeToFlac(pcmBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-f", "s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "-i", "pipe:0",
      "-c:a", "flac",
      "-compression_level", "5",
      "-f", "flac",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let stderrOutput = "";

    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (data: Buffer) => {
      stderrOutput += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput}`));
      }
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`ffmpeg spawn error: ${err.message}`));
    });

    ffmpeg.stdin.write(pcmBuffer);
    ffmpeg.stdin.end();
  });
}

// Generate date-based file path
function generateFilePath(deviceId: string, recordingId: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  return join(
    STORAGE_DIR,
    "recordings",
    deviceId,
    String(year),
    month,
    day,
    `${timestamp}_${recordingId.slice(0, 8)}.flac`
  );
}

function calculateSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Save audio buffer locally and queue for upload.
 */
export async function saveRecording(
  pcmBuffer: Buffer,
  metadata: RecordingMetadata
): Promise<string> {
  const id = randomUUID();
  const { sessionId, deviceId, participantId, turnNumber, activityId, durationMs, role, transcript } = metadata;
  const recordedAt = new Date().toISOString();

  let audioBuffer: Buffer;
  let codec = "flac";
  try {
    audioBuffer = await encodeToFlac(pcmBuffer);
  } catch (err) {
    logger.warn("audio", `FLAC encoding failed, saving raw PCM: ${err}`);
    audioBuffer = pcmBuffer;
    codec = "pcm";
  }

  const filePath = generateFilePath(deviceId, id);
  const finalPath = codec === "pcm" ? filePath.replace(".flac", ".pcm") : filePath;

  mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });

  const sha256 = calculateSha256(audioBuffer);
  writeFileSync(finalPath, audioBuffer, { mode: 0o600 });

  const deleteAfter = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const database = getDb();
  database.prepare(`
    INSERT INTO recordings (
      id, session_id, device_id, participant_id, turn_number, role, activity_id,
      duration_ms, file_size_bytes, codec, file_path, sha256, transcript, recorded_at, delete_after_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, sessionId, deviceId, participantId ?? null, turnNumber, role, activityId ?? null,
    durationMs, audioBuffer.length, codec, finalPath, sha256, transcript ?? null, recordedAt, deleteAfter
  );

  const ratio = (pcmBuffer.length / audioBuffer.length).toFixed(1);
  logger.info("audio", `Saved ${finalPath} (${audioBuffer.length} bytes, ${ratio}x compression, role=${role})`);

  return id;
}

/**
 * Get pending uploads from the queue.
 */
export function getPendingUploads(limit = 10): Recording[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM recordings
    WHERE upload_status IN ('pending', 'failed')
      AND upload_attempts < ?
    ORDER BY recorded_at ASC
    LIMIT ?
  `).all(MAX_UPLOAD_ATTEMPTS, limit) as Recording[];
}

/**
 * Update upload status for a recording.
 */
export function updateUploadStatus(
  id: string,
  status: "uploading" | "uploaded" | "failed",
  remoteUrl?: string
): void {
  const database = getDb();
  const now = new Date().toISOString();

  if (status === "uploaded") {
    database.prepare(`
      UPDATE recordings
      SET upload_status = ?, remote_url = ?, uploaded_at = ?
      WHERE id = ?
    `).run(status, remoteUrl, now, id);
  } else {
    database.prepare(`
      UPDATE recordings
      SET upload_status = ?, upload_attempts = upload_attempts + 1, last_attempt_at = ?
      WHERE id = ?
    `).run(status, now, id);
  }
}

/**
 * Cleanup old uploaded recordings past retention period.
 */
export function cleanupOldRecordings(): number {
  const database = getDb();
  const now = new Date().toISOString();

  const toDelete = database.prepare(`
    SELECT file_path FROM recordings
    WHERE upload_status = 'uploaded' AND delete_after_utc < ?
  `).all(now) as { file_path: string }[];

  for (const { file_path } of toDelete) {
    try {
      if (existsSync(file_path)) unlinkSync(file_path);
    } catch (e) {
      logger.warn("audio", `Failed to delete ${file_path}: ${e}`);
    }
  }

  const result = database.prepare(`
    DELETE FROM recordings WHERE upload_status = 'uploaded' AND delete_after_utc < ?
  `).run(now);

  if (result.changes > 0) {
    logger.info("audio", `Cleaned up ${result.changes} old recordings`);
  }

  return result.changes;
}

/**
 * Get recording file buffer for upload.
 */
export function getRecordingBuffer(filePath: string): Buffer | null {
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Check if upload is enabled.
 */
export function isUploadEnabled(): boolean {
  return UPLOAD_ENABLED;
}

/**
 * Process the upload queue - upload pending recordings to backend.
 */
export async function processUploadQueue(): Promise<number> {
  if (!UPLOAD_ENABLED) {
    return 0;
  }

  const pending = getPendingUploads(5);
  let uploaded = 0;

  for (const recording of pending) {
    updateUploadStatus(recording.id, "uploading");

    const result = await uploadAudioRecording(recording.id, recording.file_path, {
      session_id: recording.session_id,
      device_id: recording.device_id,
      participant_id: recording.participant_id ?? undefined,
      turn_number: recording.turn_number,
      role: recording.role as "user" | "assistant",
      activity_id: recording.activity_id ?? undefined,
      duration_ms: recording.duration_ms,
      recorded_at: recording.recorded_at,
      sha256: recording.sha256 ?? undefined,
      transcript: recording.transcript ?? undefined,
    });

    if (result.success) {
      updateUploadStatus(recording.id, "uploaded", result.url);
      uploaded++;
      logger.info("audio", `Uploaded recording ${recording.id}`);
    } else {
      updateUploadStatus(recording.id, "failed");
      logger.warn("audio", `Upload failed for ${recording.id} (attempt ${recording.upload_attempts + 1})`);
    }
  }

  if (uploaded > 0) {
    logger.info("audio", `Processed upload queue: ${uploaded}/${pending.length} uploaded`);
  }

  return uploaded;
}

/**
 * Close database connection.
 */
export function closeAudioDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
