/**
 * @file shared/json-utils.ts
 * @description Robust parsing for LLM output: strips markdown code fences,
 *   extracts the first balanced JSON object (tolerating trailing text that
 *   reasoning models append after the closing brace), falls back to truncation
 *   repair, and converts Claude-style `<invoke name="...">` XML tool calls
 *   (a common training drift of DeepSeek reasoning models) into structured
 *   tool-call candidates.
 * @module shared
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

/**
 * @typedef XmlInvokeCall
 * @description A parsed Claude-style XML tool call: `<invoke name="toolName">`
 *   with optional `<parameter name="key" string="false">value</parameter>`
 *   children. The `string` attribute marks the value as non-string (number,
 *   boolean) — it is coerced accordingly.
 */
export type XmlInvokeCall = {
  toolName: string
  params: Record<string, unknown>
}

/**
 * @function decodeXmlEntities
 * @description Decodes the XML/HTML entities an LLM may emit inside tool-call
 *   text (quotes, ampersand, angle brackets).
 * @param {string} raw - Value possibly containing entities.
 * @returns {string} Decoded value.
 */
function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

/**
 * @function normalizeXmlInput
 * @description Sanitizes raw LLM output before XML tool-call extraction:
 *   strips control/invisible characters that are not JS `\s` (zero-width
 *   spaces, soft hyphens, BOM, line/paragraph separators — reasoning models
 *   drift into these, breaking `\s+` in the invoke regex), trims surrounding
 *   whitespace, and removes a leading `{`/`}` (models sometimes emit a
 *   JSON/XML hybrid starting with a brace).
 * @param {string} content - The raw LLM output text.
 * @returns {string} Sanitized text ready for regex extraction.
 */
function normalizeXmlInput(content: string): string {
  return content
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
    .trim()
    .replace(/^[{}]+/, "")
}

/**
 * @function parseInvokeXml
 * @description Extracts Claude-style `<invoke name="...">` tool-call blocks
 *   from LLM output — the format DeepSeek reasoning models drift into instead
 *   of emitting JSON or native tool_calls. Tolerates single-quoted names, a
 *   leading `{`/`<tool_calls>` wrapper, invisible characters (normalized
 *   away), and truncated blocks missing `</invoke>` (auto-closed at end of
 *   input, parameters parsed best-effort). Values carrying the
 *   `string="false"` attribute are coerced to numbers (or booleans) so zod
 *   params validation accepts them as-is.
 * @param {string} content - The raw LLM output text.
 * @returns {XmlInvokeCall[] | null} Parsed tool calls, or null when no
 *   `<invoke>` block exists (so callers can distinguish "no XML" from
 *   "empty XML").
 */
export function parseInvokeXml(content: string): XmlInvokeCall[] | null {
  const normalized = normalizeXmlInput(content)
  const blockRe = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi
  const paramRe = /<parameter\s+name=["']([^"']+)["'](?:\s+string="([^"]*)")?\s*>([\s\S]*?)<\/parameter>/gi
  const calls: XmlInvokeCall[] = []

  for (const block of normalized.matchAll(blockRe)) {
    const toolName = block[1].trim()
    const inner = block[2]
    const params: Record<string, unknown> = {}

    for (const p of inner.matchAll(paramRe)) {
      const key = p[1].trim()
      let value: unknown = decodeXmlEntities(p[3].trim())
      // reason: `string="false"` is Claude's type hint — the value is a literal
      // number/boolean, not text; coerce so zod's typed params accept it.
      if (p[2]?.trim() === "false") {
        if (value === "true") value = true
        else if (value === "false") value = false
        else {
          const num = Number(value)
          if (Number.isFinite(num)) value = num
        }
      }
      params[key] = value
    }

    calls.push({ toolName, params })
  }

  // reason: truncated output (max_tokens hit mid-block) never yields the
  // closing `</invoke>` — auto-close any dangling `<invoke name="...">` at
  // end of input so the tool call is executed (read-only tools, safe) instead
  // of discarding the whole response into a retry.
  const openRe = /<invoke\s+name=["']([^"']+)["']\s*>/gi
  const closedPositions = new Set<number>()
  for (const block of normalized.matchAll(blockRe)) {
    closedPositions.add(block.index ?? -1)
  }
  for (const open of normalized.matchAll(openRe)) {
    if (closedPositions.has(open.index ?? -1)) continue
    const toolName = open[1].trim()
    const inner = normalized.slice((open.index ?? 0) + open[0].length)
    const params: Record<string, unknown> = {}
    for (const p of inner.matchAll(paramRe)) {
      const key = p[1].trim()
      // reason: truncated blocks can't be reliably type-hinted — keep values
      // as text; tool zod schemas tolerate strings via coercion where needed.
      params[key] = decodeXmlEntities(p[3].trim())
    }
    calls.push({ toolName, params })
  }

  return calls.length > 0 ? calls : null
}
