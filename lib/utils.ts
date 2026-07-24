import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Run an async function or promise with a timeout.
 * ponytail: accepts both Promise and () => Promise for backwards compat.
 */
export async function withTimeout<T>(input: Promise<T> | (() => Promise<T>), ms: number): Promise<T> {
  const promise = typeof input === "function" ? input() : input
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ])
}

/**
 * Retry an async function with exponential backoff.
 * ponytail: simple loop, no jitter — good enough for API retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; backoff?: number } = {},
): Promise<T> {
  const { retries = 3, delayMs = 1000, backoff = 2 } = opts
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * backoff ** attempt))
      }
    }
  }
  throw lastError
}
