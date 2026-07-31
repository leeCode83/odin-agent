/**
 * @file planning/log.ts
 * @description Leveled console logger for the planning swarm (spec §9.8).
 * DEBUG is gated behind NODE_ENV === "development"; info/warn/error always
 * emit. Event names follow the §9.8 table, e.g. "planning.started",
 * "perspective.step", "perspective.completed", "aggregation.completed",
 * "consensus.evaluated", "planning.redeploy", "planning.no_trade",
 * "tool.failure", "llm.failure", "circuit.tripped", "planning.completed".
 * @module planning/log
 * @layer agent
 */

/**
 * @type LogLevel
 * @description Severity levels supported by the planning logger.
 */
export type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * @function consoleForLevel
 * @description Maps a log level to its console method.
 * // reason: warn/error must reach stderr per spec §9.8; debug/info use stdout.
 * @param {LogLevel} level - The log level.
 * @returns {(message?: unknown, ...optionalParams: unknown[]) => void} The console method.
 */
function consoleForLevel(
  level: LogLevel
): (message?: unknown, ...optionalParams: unknown[]) => void {
  switch (level) {
    case "warn":
      return console.warn
    case "error":
      return console.error
    default:
      return console.log
  }
}

/**
 * @function log
 * @description Emits a leveled log line: `[level] event` plus an optional
 * data payload. DEBUG lines are dropped unless NODE_ENV === "development".
 * @param {LogLevel} level - Severity of the event.
 * @param {string} event - Event name (spec §9.8 table).
 * @param {Record<string, unknown>} [data] - Structured event payload.
 * @returns {void}
 */
export function log(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>
): void {
  if (level === "debug" && process.env.NODE_ENV !== "development") return
  const out = consoleForLevel(level)
  if (data !== undefined) {
    out(`[${level}] ${event}`, data)
  } else {
    out(`[${level}] ${event}`)
  }
}
