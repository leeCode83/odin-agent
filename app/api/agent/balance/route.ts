/**
 * @file route.ts
 * @description GET /api/agent/balance — returns detailed user balance from Hyperliquid clearing state.
 * @module API
 * @layer controller
 */

import { NextRequest, NextResponse } from "next/server"
import { fetchUserBalance } from "@/lib/data/hyperliquid"

/**
 * @function GET
 * @description Returns the current user balance detail (withdrawable, account value, margin, open positions).
 * @param {NextRequest} req - Request with walletAddress query param (0x-prefixed 40-char hex).
 * @returns {NextResponse} 200 with UserBalance JSON, 400 if param missing/invalid, 500 on fetch error.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const walletAddress = searchParams.get("walletAddress")

  if (!walletAddress) {
    return NextResponse.json(
      { error: "walletAddress query parameter required" },
      { status: 400 }
    )
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return NextResponse.json(
      { error: "Invalid walletAddress — must be a 0x-prefixed 40-char hex address" },
      { status: 400 }
    )
  }

  try {
    const balance = await fetchUserBalance(walletAddress)
    return NextResponse.json(balance)
  } catch (err) {
    console.error("Balance fetch error:", err)
    return NextResponse.json(
      { error: "Failed to fetch user balance", detail: String(err) },
      { status: 500 }
    )
  }
}
