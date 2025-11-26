/**
 * Comprehensive logging utility with timestamps
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL = (process.env.COCO_LOG_LEVEL ?? "debug").toLowerCase() as LogLevel;
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function timestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

function formatMessage(level: LogLevel, tag: string, message: string, data?: unknown): string {
  const ts = timestamp();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  if (data !== undefined) {
    const dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 0);
    return `${prefix} ${message} ${dataStr}`;
  }
  return `${prefix} ${message}`;
}

export const log = {
  debug(tag: string, message: string, data?: unknown) {
    if (shouldLog("debug")) {
      console.debug(formatMessage("debug", tag, message, data));
    }
  },

  info(tag: string, message: string, data?: unknown) {
    if (shouldLog("info")) {
      console.info(formatMessage("info", tag, message, data));
    }
  },

  warn(tag: string, message: string, data?: unknown) {
    if (shouldLog("warn")) {
      console.warn(formatMessage("warn", tag, message, data));
    }
  },

  error(tag: string, message: string, data?: unknown) {
    if (shouldLog("error")) {
      console.error(formatMessage("error", tag, message, data));
    }
  },

  // Special formatted logs for specific events
  request(method: string, url: string, payload?: unknown, attempt?: number, maxAttempts?: number) {
    const attemptStr = attempt && maxAttempts ? ` (attempt ${attempt}/${maxAttempts})` : "";
    log.info("http", `${method} ${url}${attemptStr}`);
    if (payload) {
      log.debug("http", "Request payload:", payload);
    }
  },

  response(method: string, url: string, status: number, durationMs: number, body?: unknown) {
    const emoji = status >= 200 && status < 300 ? "✓" : "✗";
    log.info("http", `${emoji} ${method} ${url} → ${status} (${durationMs}ms)`);
    if (body) {
      log.debug("http", "Response body:", body);
    }
  },

  lifecycle(event: string, details?: unknown) {
    log.info("lifecycle", `◆ ${event}`, details);
  },

  audio(event: string, details?: unknown) {
    log.debug("audio", `🔊 ${event}`, details);
  },

  speech(event: string, details?: unknown) {
    log.info("speech", `🎤 ${event}`, details);
  },

  session(event: string, details?: unknown) {
    log.info("session", `📍 ${event}`, details);
  },
};

export default log;
