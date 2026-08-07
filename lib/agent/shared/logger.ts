/**
 * @file shared/logger.ts
 * @description Unified structured logger for all agent modules. Outputs JSON to
 *   console with timestamp, level, event name, and merged context. Replaces both
 *   DD's ddLog/createDdLogger and Planning's log function.
 * @module shared
 * @layer util
 */

/**
 * @typedef LogLevel
 * @description Severity levels for structured logging.
 */
export type LogLevel = "info" | "warn" | "error"

/**
 * @function ddLog
 * @description Writes a structured log entry as JSON to the appropriate console method.
 *   Output format: { event, level, ts, ...context }
 * @param {LogLevel} level - Severity of the event.
 * @param {string} event - Name of the event.
 * @param {Record<string, unknown>} [context={}] - Additional context data.
 */
export function ddLog(level: LogLevel, event: string, context: Record<string, unknown> = {}) {
  const logString = JSON.stringify({ event, level, ts: Date.now(), ...context })
  switch (level) {
    case "info":
      console.info(logString)
      break
    case "warn":
      console.warn(logString)
      break
    case "error":
      console.error(logString)
      break
  }
}

/**
 * @function createLogger
 * @description Creates a bound logger with pre-set base context. All log calls
 *   will include the base context merged with per-call context.
 * @param {Record<string, unknown>} baseContext - Context included in every log entry.
 * @returns {(level: LogLevel, event: string, context?: Record<string, unknown>) => void} Bound logger function.
 */
export function createLogger(baseContext: Record<string, unknown>) {
  return (level: LogLevel, event: string, context: Record<string, unknown> = {}) => {
    ddLog(level, event, { ...baseContext, ...context })
  }
}
