/**
 * Retry utility for API calls with timeout and exponential backoff
 */

// Default config (can be overridden via env vars)
export const API_TIMEOUT_MS = Number(process.env.COCO_API_TIMEOUT_MS ?? "30000");
export const API_RETRIES = Number(process.env.COCO_API_RETRIES ?? "2");
export const RETRY_DELAY_MS = 500;

export type RetryableError = Error & { status?: number };

/**
 * Check if an error is retryable (transient network/server errors)
 */
export function isRetryableError(err: RetryableError): boolean {
  const message = err.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    (typeof err.status === "number" && err.status >= 500)
  );
}

/**
 * Wrapper for async operations with retry logic
 *
 * @param operation - Async function to execute
 * @param label - Label for logging
 * @param options - Optional config overrides
 * @returns Result of the operation
 * @throws Last error if all retries exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  options: {
    maxRetries?: number;
    delayMs?: number;
    logger?: (msg: string) => void;
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? API_RETRIES;
  const delayMs = options.delayMs ?? RETRY_DELAY_MS;
  const log = options.logger ?? console.log;

  let lastError: RetryableError | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err instanceof Error ? err as RetryableError : new Error(String(err));
      const isLastAttempt = attempt > maxRetries;

      if (isLastAttempt || !isRetryableError(lastError)) {
        log(`${label}: FAILED after ${attempt} attempt(s) - ${lastError.message}`);
        throw lastError;
      }

      log(`${label}: Attempt ${attempt}/${maxRetries + 1} failed, retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
