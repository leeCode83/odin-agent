const BASE = process.env.PUBLICDROP_BASE_URL || "https://api.publicdrop.org/v1"

export interface PublicDropData {
  marketCap: number | null
  volume24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
}

export async function fetchPublicDropData(asset: string): Promise<PublicDropData | null> {
  try {
    const res = await fetch(`${BASE}/assets/${asset.toLowerCase()}`)
    if (!res.ok) return null
    const data = await res.json()
    return {
      marketCap: data?.market_cap ?? null,
      volume24h: data?.volume_24h ?? null,
      circulatingSupply: data?.circulating_supply ?? null,
      totalSupply: data?.total_supply ?? null,
    }
  } catch {
    return null
  }
}
