import { HttpTransport, ExchangeClient, InfoClient } from "@nktkas/hyperliquid"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import type { Account } from "viem"

export function getAgentSigner(privateKey: string): Account {
  return privateKeyToAccount(privateKey as `0x${string}`)
}

function createTransport(): HttpTransport {
  const isTestnet = process.env.HYPERLIQUID_TESTNET !== "false"
  return new HttpTransport({ isTestnet })
}

export function getExchangeClient(signer: Account): ExchangeClient {
  const transport = createTransport()
  return new ExchangeClient({ transport, wallet: signer as never } as never)
}

export function getMasterSigner(): Account {
  const masterPk = process.env.MASTER_PRIVATE_KEY
  if (!masterPk) throw new Error("MASTER_PRIVATE_KEY not set")
  return privateKeyToAccount(masterPk as `0x${string}`)
}

export function getMasterClient(): ExchangeClient {
  return getExchangeClient(getMasterSigner())
}

export function generateAgentWallet(): { address: string; privateKey: string } {
  const pk = generatePrivateKey()
  return { address: privateKeyToAccount(pk).address, privateKey: pk }
}

export async function approveAgent(
  agentAddress: `0x${string}`,
  agentName: string
): Promise<void> {
  const masterClient = getMasterClient()
  await masterClient.approveAgent({ agentAddress, agentName })
}

export interface AssetInfo {
  assetIndex: number
  szDecimals: number
}

export async function getAssetIndex(asset: string): Promise<AssetInfo> {
  const transport = createTransport()
  const infoClient = new InfoClient({ transport })
  const [meta] = await infoClient.metaAndAssetCtxs()
  const idx = meta.universe.findIndex((u: { name: string }) => u.name === asset)
  if (idx === -1) throw new Error(`Asset ${asset} not found in Hyperliquid universe`)
  const entry = meta.universe[idx] as { name: string; szDecimals: number }
  return { assetIndex: idx, szDecimals: entry.szDecimals }
}
