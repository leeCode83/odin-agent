import { InfoClient, HttpTransport } from "@nktkas/hyperliquid"

export interface FillResult {
  status: "filled" | "partial" | "canceled" | "none"
  fillAmount?: string
  fillPrice?: string
  oid: number
}

export function subscribeFill(
  orderIds: number[],
  timeoutMs: number = 15_000
): Promise<FillResult[]> {
  const isTestnet = process.env.HYPERLIQUID_TESTNET !== "false"
  const wsUrl = isTestnet
    ? "wss://api.hyperliquid-testnet.xyz/ws"
    : "wss://api.hyperliquid.xyz/ws"

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl)
    const results: FillResult[] = []
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        resolve(results.length > 0 ? results : orderIds.map((oid) => ({ status: "none", oid })))
      }
    }, timeoutMs)

    ws.onopen = () => {
      const subscribeMsg = {
        type: "subscribe",
        channel: "orderUpdates",
        user: undefined,
      }
      ws.send(JSON.stringify(subscribeMsg))
    }

    ws.onmessage = (event) => {
      if (settled) return
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>
        if (data.channel === "orderUpdates" && Array.isArray(data.data)) {
          for (const m of data.data as Array<Record<string, unknown>>) {
            const oid = Number(m.oid)
            if (orderIds.includes(oid)) {
              const status = String(m.status ?? "")
              if (status === "filled" || status === "canceled") {
                results.push({
                  status: status === "filled" ? "filled" : "none",
                  fillAmount: String(m.sz ?? ""),
                  fillPrice: String(m.limitPx ?? ""),
                  oid,
                })
              }
            }
          }

          if (results.length >= orderIds.length && !settled) {
            settled = true
            clearTimeout(timer)
            ws.close()
            resolve(results)
          }
        }
      } catch {
        // parse error, ignore
      }
    }

    ws.onerror = () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        ws.close()
        resolve(orderIds.map((oid) => ({ status: "none", oid })))
      }
    }

    ws.onclose = () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(results.length > 0 ? results : orderIds.map((oid) => ({ status: "none", oid })))
      }
    }
  })
}

export async function pollOrderStatus(
  oid: number,
  intervalMs: number = 2_000,
  maxAttempts: number = 8
): Promise<FillResult> {
  const isTestnet = process.env.HYPERLIQUID_TESTNET !== "false"
  const transport = new HttpTransport({ isTestnet })
  const infoClient = new InfoClient({ transport })
  const user = (process.env.AGENT_WALLET_ADDRESS ?? "0x0") as `0x${string}`

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const statuses = await infoClient.orderStatus({ oid, user })
      const entry = Array.isArray(statuses) ? statuses[0] : (statuses as Record<string, unknown>)
      if (entry) {
        const e = entry as Record<string, unknown>
        const status = String(e.status ?? "")
        if (status === "filled") {
          return { status: "filled", fillAmount: String(e.sz ?? ""), fillPrice: String(e.limitPx ?? ""), oid }
        }
        if (status === "canceled") {
          return { status: "none", oid }
        }
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  try {
    const history = await infoClient.historicalOrders({ user })
    if (Array.isArray(history)) {
      const match = history.find((h: Record<string, unknown>) => {
        const order = h.order as Record<string, unknown> | undefined
        return order && Number(order.oid) === oid
      }) as Record<string, unknown> | undefined
      if (match) {
        const s = String(match.status ?? "")
        const order = match.order as Record<string, unknown> | undefined
        if (s === "filled") {
          return {
            status: "filled",
            fillAmount: String(order?.sz ?? ""),
            fillPrice: String(order?.limitPx ?? ""),
            oid,
          }
        }
        if (s === "canceled") {
          return { status: "canceled", oid }
        }
      }
    }
  } catch {
  }

  return { status: "none", oid }
}
