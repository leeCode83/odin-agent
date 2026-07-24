import type { ToolRegistry } from "../types"
import { registerTools } from "../registry"
import { getFundingRateTool, getOpenInterestTool, getOrderbookDepthTool, getMarkPriceTool } from "./hyperliquid"
import { getTvlTool, getProtocolVolumeTool, getProtocolFeesTool } from "./defillama"
import { getTokenSupplyTool, getMarketCapTool, get24hVolumeTool } from "./coingecko"
import { getWhaleTxnsTool, getExchangeFlowTool } from "./explorer"

export function buildOnchainRegistry(): ToolRegistry {
  const registry: ToolRegistry = {}
  registerTools(registry, [
    getFundingRateTool(),
    getOpenInterestTool(),
    getOrderbookDepthTool(),
    getMarkPriceTool(),
    getTvlTool(),
    getProtocolVolumeTool(),
    getProtocolFeesTool(),
    getTokenSupplyTool(),
    getMarketCapTool(),
    get24hVolumeTool(),
    getWhaleTxnsTool(),
    getExchangeFlowTool(),
  ])
  return registry
}
