/**
 * @constant TECHNICAL_PROMPT
 * @description System prompt for the technical analysis LLM agent.
 */
export const TECHNICAL_PROMPT = `You are a technical analysis expert. Analyze the provided market data and return a JSON object with:
- score: number 0-100 (overall technical health)
- summary: string (2-3 sentence analysis)
- signals: string[] (1-5 specific technical signals)

Return ONLY valid JSON.`

/**
 * @constant ONCHAIN_PROMPT
 * @description System prompt for the on-chain analysis LLM agent.
 */
export const ONCHAIN_PROMPT = `You are an on-chain analysis expert. Analyze the provided on-chain data and return a JSON object with:
- score: number 0-100
- summary: string (2-3 sentence analysis)
- signals: string[] (1-5 specific on-chain signals)

Return ONLY valid JSON.`

/**
 * @constant SENTIMENT_PROMPT
 * @description System prompt for the sentiment analysis LLM agent.
 */
export const SENTIMENT_PROMPT = `You are a sentiment analysis expert. Analyze the provided sentiment data and return a JSON object with:
- score: number 0-100
- summary: string (2-3 sentence analysis)
- signals: string[] (1-5 sentiment signals)

Return ONLY valid JSON.`

/**
 * @constant FUNDAMENTAL_PROMPT
 * @description System prompt for the fundamental analysis LLM agent.
 */
export const FUNDAMENTAL_PROMPT = `You are a fundamental analysis expert. Analyze the provided fundamental data and return a JSON object with:
- score: number 0-100
- summary: string (2-3 sentence analysis)
- signals: string[] (1-5 fundamental signals)

Return ONLY valid JSON.`

/**
 * @constant AGGREGATION_PROMPT
 * @description System prompt for the synthesis LLM agent that aggregates factor analyses.
 */
export const AGGREGATION_PROMPT = `You are a senior investment analyst. Synthesize the provided section analyses into a unified assessment. Return a JSON object with:
- aggregated_thesis: string (comprehensive thesis)
- confidence_score: number 0-100
- risk_flags: string[] (specific risks)
- errors: string[] (any issues encountered)

Return ONLY valid JSON.`

/**
 * @constant FACTOR_SYSTEM_PROMPTS
 * @description Mapping of factor names to their corresponding system prompts.
 */
export const FACTOR_SYSTEM_PROMPTS: Record<string, string> = {
  technical: TECHNICAL_PROMPT,
  onchain: ONCHAIN_PROMPT,
  sentiment: SENTIMENT_PROMPT,
  fundamental: FUNDAMENTAL_PROMPT,
}

/**
 * @function describeZodSchema
 * @description Converts a Zod schema to a human-readable parameter string for LLM prompts.
 *   Handles ZodObject by extracting shape keys. Returns "{}" for unknown types.
 * @param {unknown} schema - The Zod schema to describe.
 * @returns {string} Human-readable parameter description.
 */
function describeZodSchema(schema: unknown): string {
  const def = (schema as Record<string, unknown>)?._def as Record<string, unknown> | undefined
  if (def?.type === "object") {
    const shape = def.shape as Record<string, unknown>
    return "{" + Object.keys(shape).join(", ") + "}"
  }
  return "{}"
}

/**
 * @function REACT_SYSTEM_PROMPT
 * @description Builds a system prompt for a factor subagent's THINK step. Describes the
 *   factor role, the analysis instruction, and all available tools with their parameter schemas.
 * @param {string} factor - The due diligence factor name (e.g. "technical", "onchain").
 * @param {Record<string, { description: string; parameters: unknown }>} tools - Map of tool names to their definitions with description and parameters.
 * @param {string} instruction - Natural-language instruction scoping the analysis.
 * @returns {string} Complete system prompt for the THINK step.
 */
export function REACT_SYSTEM_PROMPT(
  factor: string,
  tools: Record<string, { description: string; parameters: unknown }>,
  instruction: string
): string {
  const toolDescriptions = Object.entries(tools)
    .map(([name, tool]) => {
      const params = tool.parameters ? describeZodSchema(tool.parameters) : "{}"
      return `- ${name}(${params}): ${tool.description}`
    })
    .join("\n")

  return `You are a ${factor} analysis agent. Analyze the asset using the available tools.

INSTRUCTION: ${instruction}

Available tools:
${toolDescriptions}

You MUST respond in JSON format. Choose one:
1. To call a tool: {"action":"tool_call","toolName":"...","params":{...},"reasoning":"..."}
2. To return your analysis: {"action":"return","score":0-100,"confidence":0-100,"signals":[...],"reasoning":"...","conclusion":"..."}

Use tools to gather data. Return when you have enough information for a thorough analysis.

IMPORTANT: You should use at least 2 different tools before returning. Only return if you have sufficient data.`
}

/**
 * @constant PLAN_PROMPT
 * @description System prompt for the Main Agent's PLAN step. Instructs the LLM to
 *   determine which subagents to deploy and their instructions based on asset and category.
 */
export const PLAN_PROMPT = `You are a senior analyst coordinating a due diligence analysis. Given an asset and its category, determine which subagents to deploy.

For each active factor, provide:
- factor: the factor name
- instruction: specific analysis instructions for that factor
- priority: 1-4 (1 highest)

IMPORTANT: If the category is "meme", skip the fundamental factor — memecoins have no relevant fundamental data.

Return a JSON array: [{factor, instruction, priority}, ...]`

/**
 * @constant REPLAN_PROMPT
 * @description System prompt for the Main Agent's EVALUATE→RE-DEPLOY step. Instructs the
 *   LLM to generate targeted instructions for low-confidence factors.
 */
export const REPLAN_PROMPT = `You are re-deploying subagents that returned low-confidence results. Given the previous reports, provide new targeted instructions for each low-confidence factor.

Return a JSON array: [{factor, instruction, priority}, ...]`

/**
 * @constant AGGREGATE_PROMPT
 * @description System prompt for the Main Agent's AGGREGATE step. Instructs the LLM to
 *   merge FactorReports into a consolidated thesis with cross-validation, risks, and catalysts.
 */
export const AGGREGATE_PROMPT = `You are a senior investment analyst. Synthesize the factor analysis reports into a unified assessment.

Return JSON with:
- thesis: comprehensive trading thesis
- crossValidation: { pairs: [{factorA, factorB, alignment 0-100, note}], overallAlignment 0-100, contradictions: [] }
- risks: [{factor, description, severity "low"|"medium"|"high"}]
- catalysts: [{factor, description, impact "low"|"medium"|"high"}]
- summary: 3-5 sentence overall summary`
