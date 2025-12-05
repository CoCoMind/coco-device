/**
 * Simple logging utility for the sync pipeline.
 */

function formatTs(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(level: string, component: string, message: string, data?: unknown) {
  const ts = formatTs();
  const prefix = `[${ts}] [${level}] [${component}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === "object" ? JSON.stringify(data) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export default {
  debug: (component: string, message: string, data?: unknown) => {
    if (process.env.COCO_LOG_LEVEL === "debug") {
      log("DEBUG", component, message, data);
    }
  },
  info: (component: string, message: string, data?: unknown) => {
    log("INFO", component, message, data);
  },
  warn: (component: string, message: string, data?: unknown) => {
    log("WARN", component, message, data);
  },
  error: (component: string, message: string, data?: unknown) => {
    log("ERROR", component, message, data);
  },
  lifecycle: (message: string, data?: unknown) => {
    log("LIFECYCLE", "session", message, data);
  },
  request: (method: string, url: string, body: unknown, attempt: number, totalAttempts: number) => {
    log("HTTP", "request", `${method} ${url} (attempt ${attempt}/${totalAttempts})`, body);
  },
  response: (method: string, url: string, status: number, durationMs: number, body?: unknown) => {
    const msg = `${method} ${url} -> ${status} (${durationMs}ms)`;
    if (body !== undefined) {
      log("HTTP", "response", msg, body);
    } else {
      log("HTTP", "response", msg);
    }
  },
};
