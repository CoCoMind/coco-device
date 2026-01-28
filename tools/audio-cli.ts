#!/usr/bin/env npx tsx

/**
 * Audio CLI - Query local and remote recordings
 *
 * Usage:
 *   npx tsx tools/audio-cli.ts <command> [args]
 *
 * Local commands (on device):
 *   list              List recent local recordings
 *   pending           Show pending uploads
 *   play <id>         Play a recording (id prefix works)
 *   stats             Show local storage stats
 *
 * Remote commands (requires DATABASE_URL):
 *   list-all          All recordings across devices
 *   by-device <id>    Filter by device
 *   by-participant <id>  Filter by participant
 *   remote-stats      Storage stats by device
 */

import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const command = args[0];

const STORAGE_DIR = process.env.COCO_AUDIO_STORAGE_DIR ?? "/var/lib/coco";
const DB_PATH = `${STORAGE_DIR}/audio.db`;

function printHelp() {
  console.log(`
Audio CLI - Query local and remote recordings

Local commands (on device):
  audio-cli list              List recent local recordings
  audio-cli pending           Show pending uploads
  audio-cli play <id>         Play a recording (id prefix works)
  audio-cli stats             Show local storage stats

Remote commands (requires DATABASE_URL env var):
  DATABASE_URL=... audio-cli list-all          All recordings across devices
  DATABASE_URL=... audio-cli by-device <id>    Filter by device
  DATABASE_URL=... audio-cli by-participant <id>  Filter by participant
  DATABASE_URL=... audio-cli remote-stats      Storage stats by device

Environment variables:
  COCO_AUDIO_STORAGE_DIR   Local storage directory (default: /var/lib/coco)
  DATABASE_URL             PostgreSQL connection string for remote queries
`);
}

// Local SQLite queries
function queryLocal() {
  if (!existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    console.error("No recordings have been saved yet.");
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });

  try {
    switch (command) {
      case "list": {
        const rows = db.prepare(`
          SELECT
            substr(id, 1, 8) as id,
            turn_number,
            round(duration_ms / 1000.0, 1) as duration_sec,
            round(file_size_bytes / 1024.0, 1) as size_kb,
            upload_status,
            substr(recorded_at, 1, 19) as recorded_at
          FROM recordings
          ORDER BY recorded_at DESC
          LIMIT 20
        `).all();
        console.log("\nRecent recordings:");
        console.table(rows);
        break;
      }

      case "pending": {
        const rows = db.prepare(`
          SELECT
            substr(id, 1, 8) as id,
            upload_attempts as attempts,
            round(file_size_bytes / 1024.0, 1) as size_kb,
            substr(recorded_at, 1, 19) as recorded_at
          FROM recordings
          WHERE upload_status IN ('pending', 'failed')
          ORDER BY recorded_at ASC
        `).all();
        console.log("\nPending uploads:");
        console.table(rows);
        console.log(`Total pending: ${rows.length}`);
        break;
      }

      case "play": {
        const id = args[1];
        if (!id) {
          console.error("Usage: audio-cli play <id>");
          process.exit(1);
        }
        const row = db.prepare(`
          SELECT file_path, codec FROM recordings WHERE id LIKE ?
        `).get(`${id}%`) as { file_path: string; codec: string } | undefined;

        if (!row) {
          console.error(`Recording not found: ${id}`);
          process.exit(1);
        }

        if (!existsSync(row.file_path)) {
          console.error(`File not found: ${row.file_path}`);
          process.exit(1);
        }

        console.log(`Playing: ${row.file_path}`);
        // Use ffplay for opus files, aplay for pcm
        if (row.codec === "opus" || row.file_path.endsWith(".opus")) {
          spawn("ffplay", ["-nodisp", "-autoexit", row.file_path], { stdio: "inherit" });
        } else {
          spawn("aplay", ["-t", "raw", "-f", "S16_LE", "-c", "1", "-r", "24000", row.file_path], { stdio: "inherit" });
        }
        break;
      }

      case "stats": {
        const stats = db.prepare(`
          SELECT
            COUNT(*) as total_recordings,
            round(COALESCE(SUM(file_size_bytes), 0) / 1024.0 / 1024.0, 2) as total_mb,
            round(COALESCE(SUM(duration_ms), 0) / 1000.0 / 60.0, 1) as total_minutes,
            SUM(CASE WHEN upload_status = 'uploaded' THEN 1 ELSE 0 END) as uploaded,
            SUM(CASE WHEN upload_status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN upload_status = 'failed' THEN 1 ELSE 0 END) as failed
          FROM recordings
        `).get();
        console.log("\nLocal storage stats:");
        console.table([stats]);
        break;
      }

      default:
        printHelp();
    }
  } finally {
    db.close();
  }
}

// Remote PostgreSQL queries (requires pg package)
async function queryRemote() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required for remote queries");
    process.exit(1);
  }

  // Dynamic import pg to avoid requiring it when not needed
  let Client;
  try {
    const pg = await import("pg");
    Client = pg.Client;
  } catch {
    console.error("pg package not installed. Install with: npm install pg");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    switch (command) {
      case "list-all": {
        const result = await client.query(`
          SELECT
            device_id,
            substring(id::text, 1, 8) as id,
            turn_number,
            round(duration_ms / 1000.0, 1) as duration_sec,
            round(file_size_bytes / 1024.0, 1) as size_kb,
            recorded_at::date as date
          FROM audio_recordings
          ORDER BY recorded_at DESC
          LIMIT 50
        `);
        console.log("\nAll recordings:");
        console.table(result.rows);
        break;
      }

      case "by-device": {
        const deviceId = args[1];
        if (!deviceId) {
          console.error("Usage: audio-cli by-device <device_id>");
          process.exit(1);
        }
        const result = await client.query(`
          SELECT
            substring(session_id::text, 1, 8) as session,
            turn_number,
            round(duration_ms / 1000.0, 1) as duration_sec,
            storage_url,
            recorded_at::timestamp(0) as recorded_at
          FROM audio_recordings
          WHERE device_id = $1
          ORDER BY recorded_at DESC
          LIMIT 50
        `, [deviceId]);
        console.log(`\nRecordings for device: ${deviceId}`);
        console.table(result.rows);
        break;
      }

      case "by-participant": {
        const participantId = args[1];
        if (!participantId) {
          console.error("Usage: audio-cli by-participant <participant_id>");
          process.exit(1);
        }
        const result = await client.query(`
          SELECT
            device_id,
            substring(session_id::text, 1, 8) as session,
            turn_number,
            round(duration_ms / 1000.0, 1) as duration_sec,
            recorded_at::date as date
          FROM audio_recordings
          WHERE participant_id = $1
          ORDER BY recorded_at DESC
          LIMIT 50
        `, [participantId]);
        console.log(`\nRecordings for participant: ${participantId}`);
        console.table(result.rows);
        break;
      }

      case "remote-stats": {
        const result = await client.query(`
          SELECT
            device_id,
            COUNT(*) as recordings,
            round(SUM(file_size_bytes) / 1024.0 / 1024.0, 2) as total_mb,
            round(SUM(duration_ms) / 1000.0 / 60.0, 1) as total_minutes,
            MIN(recorded_at)::date as first_recording,
            MAX(recorded_at)::date as last_recording
          FROM audio_recordings
          GROUP BY device_id
          ORDER BY total_mb DESC
        `);
        console.log("\nStorage stats by device:");
        console.table(result.rows);
        break;
      }

      default:
        printHelp();
    }
  } finally {
    await client.end();
  }
}

// Main
const localCommands = ["list", "pending", "play", "stats"];
const remoteCommands = ["list-all", "by-device", "by-participant", "remote-stats"];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (localCommands.includes(command)) {
  queryLocal();
} else if (remoteCommands.includes(command)) {
  queryRemote().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
