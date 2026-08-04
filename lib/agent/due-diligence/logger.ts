/**
 * Structured JSON logging for Due Diligence agent.
 */

export type LogLevel = "info" | "warn" | "error"

/**
 * Log an event with structured JSON output.
 * @param level - The log level (info, warn, error).
 * @param event - A short identifier for the event (e.g., 'subagent_timeout').
 * @param context - Additional contextual data to include in the log.
 */
export function ddLog(level: LogLevel, event: string, context: Record<string, unknown> = {}) {
  const payload = {
    ...context,
    event,
    level,
    ts: Date.now(),
  }

  const logString = JSON.stringify(payload)

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
 * Creates a bound logger with default context injected into every log.
 * @param baseContext - Context to include in all logs from this instance.
 */
export function createDdLogger(baseContext: Record<string, unknown>) {
  return (level: LogLevel, event: string, context: Record<string, unknown> = {}) => {
    ddLog(level, event, { ...baseContext, ...context })
  }
}
