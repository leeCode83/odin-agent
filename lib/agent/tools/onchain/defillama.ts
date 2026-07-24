import { z } from "zod"
import type { ToolDefinition } from "../types"

const DEFILLAMA_BASE = "https://api.llama.fi"

async function fetchWithTimeout(url: string, ms = 10_000): Promise<Response> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res
  } finally {
    clearTimeout(id)
  }
}

export function getTvlTool(): ToolDefinition {
  return {
    name: "get_tvl",
    description: "Get TVL (Total Value Locked) for a DeFi protocol on DeFiLlama, or chain TVLs if protocol is omitted",
    parameters: z.object({
      protocol: z.string().optional().describe("Protocol slug (e.g. lido, uniswap)"),
      chain: z.string().optional().describe("Chain name filter (e.g. ethereum)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        if (params.protocol) {
          const res = await fetchWithTimeout(`${DEFILLAMA_BASE}/tvl/${params.protocol}`)
          if (!res.ok) {
            return {
              success: false,
              error: `DeFiLlama API error: ${res.status}`,
              metadata: { source: "defillama", latencyMs: Date.now() - start },
            }
          }
          const tvl = await res.json() as number
          return {
            success: true,
            data: { protocol: params.protocol, tvl },
            metadata: { source: "defillama", latencyMs: Date.now() - start },
          }
        }
        const res = await fetchWithTimeout(`${DEFILLAMA_BASE}/v2/chains`)
        if (!res.ok) {
          return {
            success: false,
            error: `DeFiLlama API error: ${res.status}`,
            metadata: { source: "defillama", latencyMs: Date.now() - start },
          }
        }
        const chains = await res.json() as Array<{ gecko_id: string; tvl: number; name: string; chainId?: number }>
        const filtered = params.chain
          ? chains.filter((c) => c.gecko_id?.toLowerCase() === params.chain!.toLowerCase())
          : chains
        return {
          success: true,
          data: { chains: filtered.slice(0, 20) },
          metadata: { source: "defillama", latencyMs: Date.now() - start },
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          metadata: { source: "defillama", latencyMs: Date.now() - start },
        }
      }
    },
  }
}

export function getProtocolVolumeTool(): ToolDefinition {
  return {
    name: "get_protocol_volume",
    description: "Get 24h trading volume for a DeFi protocol on DeFiLlama",
    parameters: z.object({
      protocol: z.string().describe("Protocol slug (e.g. uniswap, curve)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const res = await fetchWithTimeout(`${DEFILLAMA_BASE}/overview/fees/${params.protocol}?dataType=dailyVolume`)
        if (!res.ok) {
          return {
            success: false,
            error: `DeFiLlama API error: ${res.status}`,
            metadata: { source: "defillama", latencyMs: Date.now() - start },
          }
        }
        const data = await res.json() as Record<string, unknown>
        return {
          success: true,
          data: { protocol: params.protocol, ...data },
          metadata: { source: "defillama", latencyMs: Date.now() - start },
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          metadata: { source: "defillama", latencyMs: Date.now() - start },
        }
      }
    },
  }
}

export function getProtocolFeesTool(): ToolDefinition {
  return {
    name: "get_protocol_fees",
    description: "Get fee data for a DeFi protocol on DeFiLlama",
    parameters: z.object({
      protocol: z.string().describe("Protocol slug (e.g. uniswap, lido)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const res = await fetchWithTimeout(`${DEFILLAMA_BASE}/overview/fees/${params.protocol}`)
        if (!res.ok) {
          return {
            success: false,
            error: `DeFiLlama API error: ${res.status}`,
            metadata: { source: "defillama", latencyMs: Date.now() - start },
          }
        }
        const data = await res.json() as Record<string, unknown>
        return {
          success: true,
          data: { protocol: params.protocol, ...data },
          metadata: { source: "defillama", latencyMs: Date.now() - start },
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          metadata: { source: "defillama", latencyMs: Date.now() - start },
        }
      }
    },
  }
}
