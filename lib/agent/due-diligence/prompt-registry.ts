/**
 * Central registry for DD agent prompts.
 * Allows retrieving prompts with environment-based overrides for A/B testing and prompt engineering.
 */

const registry = new Map<string, string>()

/**
 * Registers a base prompt in the registry.
 * @param name The unique name of the prompt.
 * @param content The base content of the prompt.
 */
export function registerPrompt(name: string, content: string) {
  registry.set(name, content)
}

/**
 * Retrieves a prompt from the registry.
 * Checks for an environment variable override (DD_PROMPT_OVERRIDE_<NAME>) before returning the base prompt.
 * @param name The unique name of the prompt.
 * @returns The prompt content to use.
 * @throws If the prompt is not registered.
 */
export function getPrompt(name: string): string {
  if (!registry.has(name)) {
    throw new Error(`Prompt ${name} is not registered.`)
  }

  const envKey = `DD_PROMPT_OVERRIDE_${name}`
  const override = process.env[envKey]
  if (override) {
    return override
  }

  return registry.get(name)!
}
