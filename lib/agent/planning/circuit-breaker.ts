/**
 * @file planning/circuit-breaker.ts
 * @description In-memory circuit breaker (spec §9.7) preventing cascading
 * planning failures: DD agent failures and LLM failures are counted in
 * sliding timestamp windows; crossing a threshold rejects planning requests
 * for a cooldown period. State is per-process, reset on restart.
 * @module planning/circuit-breaker
 * @layer agent
 */

/**
 * @constant DD_WINDOW_MS
 * @description Sliding window (5 min) for DD agent failures.
 */
const DD_WINDOW_MS = 5 * 60 * 1000

/**
 * @constant DD_FAILURE_THRESHOLD
 * @description DD failures within the window that trip the breaker.
 */
const DD_FAILURE_THRESHOLD = 3

/**
 * @constant DD_COOLDOWN_MS
 * @description Rejection period (60 s) after the DD breaker trips.
 */
const DD_COOLDOWN_MS = 60 * 1000

/**
 * @constant LLM_WINDOW_MS
 * @description Sliding window (10 min) for LLM failures.
 */
const LLM_WINDOW_MS = 10 * 60 * 1000

/**
 * @constant LLM_FAILURE_THRESHOLD
 * @description LLM failures within the window that trip the breaker.
 */
const LLM_FAILURE_THRESHOLD = 5

/**
 * @constant LLM_COOLDOWN_MS
 * @description Rejection period (120 s) after the LLM breaker trips.
 */
const LLM_COOLDOWN_MS = 120 * 1000

/**
 * @class PlanningCircuitBreaker
 * @description Sliding-window circuit breaker for planning dependencies.
 * record*Failure() timestamps a failure; when the window contains at least
 * the threshold of failures, the breaker rejects (is*Panicked()) until the
 * cooldown expires. Old failures slide out of the window on each check.
 * // reason: in-memory per spec §9.7 — no persistence, resets on restart.
 */
export class PlanningCircuitBreaker {
  private ddFailures: number[] = []
  private llmFailures: number[] = []
  private ddPanicUntil = 0
  private llmPanicUntil = 0

  /**
   * @function prune
   * @description Drops failure timestamps older than the given window.
   * // reason: keeps the window truly sliding — failures age out instead of
   * // accumulating forever.
   * @param {number[]} failures - Failure timestamp list.
   * @param {number} now - Current epoch ms.
   * @param {number} windowMs - Window length.
   * @returns {number[]} Pruned list.
   */
  private prune(failures: number[], now: number, windowMs: number): number[] {
    return failures.filter((t) => now - t < windowMs)
  }

  /**
   * @function recordDDFailure
   * @description Records a DD agent failure; trips the breaker (60 s reject)
   * once ≥3 failures fall within the 5-min sliding window.
   * @returns {void}
   */
  recordDDFailure(): void {
    const now = Date.now()
    this.ddFailures.push(now)
    this.ddFailures = this.prune(this.ddFailures, now, DD_WINDOW_MS)
    if (this.ddFailures.length >= DD_FAILURE_THRESHOLD) {
      this.ddPanicUntil = Math.max(this.ddPanicUntil, now + DD_COOLDOWN_MS)
    }
  }

  /**
   * @function isDDPanicked
   * @description Whether DD failures tripped the breaker and the 60 s
   * cooldown is still running.
   * @returns {boolean} True when planning should reject due to DD failures.
   */
  isDDPanicked(): boolean {
    const now = Date.now()
    this.ddFailures = this.prune(this.ddFailures, now, DD_WINDOW_MS)
    return now < this.ddPanicUntil
  }

  /**
   * @function recordLLMFailure
   * @description Records an LLM failure; trips the breaker (120 s reject)
   * once ≥5 failures fall within the 10-min sliding window.
   * @returns {void}
   */
  recordLLMFailure(): void {
    const now = Date.now()
    this.llmFailures.push(now)
    this.llmFailures = this.prune(this.llmFailures, now, LLM_WINDOW_MS)
    if (this.llmFailures.length >= LLM_FAILURE_THRESHOLD) {
      this.llmPanicUntil = Math.max(this.llmPanicUntil, now + LLM_COOLDOWN_MS)
    }
  }

  /**
   * @function isLLMPanicked
   * @description Whether LLM failures tripped the breaker and the 120 s
   * cooldown is still running.
   * @returns {boolean} True when planning should reject due to LLM failures.
   */
  isLLMPanicked(): boolean {
    const now = Date.now()
    this.llmFailures = this.prune(this.llmFailures, now, LLM_WINDOW_MS)
    return now < this.llmPanicUntil
  }

  /**
   * @function reset
   * @description Clears all failure history and panic state. Intended for
   * tests and process-lifetime boundaries.
   * @returns {void}
   */
  reset(): void {
    this.ddFailures = []
    this.llmFailures = []
    this.ddPanicUntil = 0
    this.llmPanicUntil = 0
  }
}

/**
 * @constant planningCircuitBreaker
 * @description Module-level singleton shared across the planning pipeline
 * (spec §9.7 — one in-memory breaker per process).
 */
export const planningCircuitBreaker = new PlanningCircuitBreaker()
