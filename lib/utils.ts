/**
 * @file utils.ts
 * @description Shared async utility functions: timeout wrapping, retry with backoff.
 * @module utils
 * @layer util
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`)
    this.name = "TimeoutError"
  }
}

/**
 * @function withTimeout
 * @description Races a promise against a timeout. If the promise does not settle within
 * the given milliseconds, rejects with TimeoutError. The underlying promise is not
 * aborted — only the race result is discarded.
 * @param {Promise<T>} promise - The operation to time-box.
 * @param {number} ms - Timeout in milliseconds.
 * @returns {Promise<T>} The result of the promise if it settles in time.
 * @throws {TimeoutError} When the timeout fires before the promise settles.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new TimeoutError(ms)), ms)
    }),
  ])
}

/**
 * @function withRetry
 * @description Calls an async factory function and retries on failure with
 * exponential backoff (1s, 2s, 4s). Defaults to 2 retries (3 total attempts).
 * @param {() => Promise<T>} fn - Factory that returns a promise for each attempt.
 * Fresh attempt = fresh call to this factory.
 * @param {object} [options]
 * @param {number} [options.retries=2] - Number of retry attempts after initial failure.
 * @param {number} [options.baseDelayMs=1000] - Base delay for exponential backoff in ms.
 * @returns {Promise<T>} The result of the first successful attempt.
 * @throws {unknown} The last error thrown by fn if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { retries?: number; baseDelayMs?: number }
): Promise<T> {
  const retries = options?.retries ?? 2
  const baseDelayMs = options?.baseDelayMs ?? 1_000

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastError
}
