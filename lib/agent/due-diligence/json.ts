/**
 * @file due-diligence/json.ts
 * @description Robust JSON parsing for LLM output: strips markdown code fences,
 *   extracts the first balanced JSON object (tolerating trailing text that
 *   reasoning models append after the closing brace), then falls back to
 *   truncation repair.
 * @module due-diligence
 * @layer util
 */

/**
 * @function extractBalancedJson
 * @description Finds the first balanced {...} object in the input by scanning
 *   characters and tracking brace depth, ignoring strings and escapes. Returns
 *   the raw substring of the first complete JSON object, or null when none is
 *   balanced. The caller must then JSON.parse the returned substring.
 * @param {string} raw - The raw LLM output text.
 * @returns {string | null} The first balanced JSON object substring, or null.
 */
function extractBalancedJson(raw: string): string | null {
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0 && start !== -1) {
        return raw.slice(start, i + 1)
      }
    }
  }
  return null
}

/**
 * @function repairJSON
 * @description Attempts to salvage truncated JSON by closing unclosed braces
 *   and brackets. Falls back to null if the input is irreparable.
 * @param {string} raw - The potentially truncated JSON string.
 * @returns {object | null} Repaired parsed object, or null if beyond repair.
 */
export function repairJSON(raw: string): object | null {
  try { return JSON.parse(raw) } catch { /* parse failed, attempt repair */ }

  let fixed = raw
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]")
    } else if (ch === "}" || ch === "]") {
      stack.pop()
    }
  }
  // Unterminated string (truncated mid-value) — close it before closing structure.
  if (inString) fixed += '"'
  // Close any unclosed braces/brackets in reverse order
  while (stack.length > 0) fixed += stack.pop()

  try { return JSON.parse(fixed) } catch { /* repair failed */ }
  return null
}

/**
 * @function parseLlmJson
 * @description Parses LLM output into JSON, tolerating the common drift of
 *   reasoning models: markdown code fences, prose before/after the JSON, and
 *   mid-way truncation. Strategy: strip code fences, extract the first balanced
 *   {...} object, parse it, and only if that fails attempt truncation repair.
 *   Returns null only when nothing salvageable exists.
 * @param {string} content - The raw LLM output text.
 * @returns {unknown | null} Parsed JSON value, or null when irreparable.
 */
export function parseLlmJson(content: string): unknown | null {
  // reason: reasoning models often wrap JSON in ```json fences — strip them so
  // the balanced-object extraction sees clean JSON.
  const stripped = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")

  try {
    return JSON.parse(stripped)
  } catch { /* fall through to balanced extraction */ }

  // reason: trailing prose after the closing brace fails JSON.parse but the
  // first balanced object is still valid — extract it instead of discarding.
  const balanced = extractBalancedJson(stripped)
  if (balanced !== null) {
    try {
      return JSON.parse(balanced)
    } catch { /* fall through to truncation repair */ }
  }

  // reason: truncation (unterminated string, unclosed braces) is salvageable
  // only when the whole output is still the JSON body — same path as before.
  const repaired = repairJSON(stripped)
  return repaired
}
