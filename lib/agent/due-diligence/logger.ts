/**
 * @file due-diligence/logger.ts
 * @description Re-export shim. Use @/lib/agent/shared/logger instead.
 * @module due-diligence
 * @layer util
 * @deprecated Import from @/lib/agent/shared/logger directly.
 */

import { ddLog, createLogger, type LogLevel } from "@/lib/agent/shared/logger"

export type { LogLevel }
export { ddLog, createLogger, createLogger as createDdLogger }
