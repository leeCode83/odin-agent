/**
 * @file planning/log.ts
 * @description Re-export shim. Delegates to shared structured logger.
 *   Use @/lib/agent/shared/logger for new code.
 * @module planning
 * @layer util
 * @deprecated Import from @/lib/agent/shared/logger directly.
 */

import { ddLog, type LogLevel } from "@/lib/agent/shared/logger"

export type { LogLevel }

/**
 * @function log
 * @description Leveled logger compatible with existing planning code.
 *   Routes to shared structured logger (JSON output).
 * @param {LogLevel} level - Severity level.
 * @param {string} event - Event name.
 * @param {Record<string, unknown>} [data] - Optional payload.
 */
export function log(level: LogLevel, event: string, data?: Record<string, unknown>) {
  ddLog(level, event, data ?? {})
}

export { ddLog, createLogger } from "@/lib/agent/shared/logger"
