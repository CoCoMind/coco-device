/**
 * Timing Utilities
 *
 * Functions for capturing and analyzing response timing.
 */

export interface TimedResponse {
  transcript: string;
  latency_ms: number; // Time from prompt end to first speech
  duration_ms: number; // Total speaking duration
  peak_rms: number;
  has_speech: boolean;
}

export interface TimingStats {
  count: number;
  total_ms: number;
  average_ms: number;
  min_ms: number;
  max_ms: number;
}

/**
 * Calculate timing statistics from a list of latencies
 */
export function calculateTimingStats(latencies: number[]): TimingStats {
  if (latencies.length === 0) {
    return {
      count: 0,
      total_ms: 0,
      average_ms: 0,
      min_ms: 0,
      max_ms: 0,
    };
  }

  const total = latencies.reduce((sum, l) => sum + l, 0);
  return {
    count: latencies.length,
    total_ms: total,
    average_ms: Math.round(total / latencies.length),
    min_ms: Math.min(...latencies),
    max_ms: Math.max(...latencies),
  };
}

/**
 * Create a timer for measuring response latency
 */
export function createLatencyTimer(): {
  start: () => void;
  stop: () => number;
  elapsed: () => number;
} {
  let startTime: number | null = null;
  let endTime: number | null = null;

  return {
    start: () => {
      startTime = Date.now();
      endTime = null;
    },
    stop: () => {
      endTime = Date.now();
      return startTime ? endTime - startTime : 0;
    },
    elapsed: () => {
      const now = endTime ?? Date.now();
      return startTime ? now - startTime : 0;
    },
  };
}

/**
 * Format milliseconds for display
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds}s`;
}

/**
 * Check if response time indicates processing difficulty
 */
export function isSlowResponse(latencyMs: number, threshold = 3000): boolean {
  return latencyMs > threshold;
}

/**
 * Check if response time indicates quick retrieval
 */
export function isFastResponse(latencyMs: number, threshold = 1000): boolean {
  return latencyMs < threshold;
}
