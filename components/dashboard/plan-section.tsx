"use client"

/**
 * @file components/dashboard/plan-section.tsx
 * @description Trade Plan panel: plans the DD section's analyzed asset with
 *   a target-profit input, and renders the resulting plan. NO_TRADE plans
 *   show their reason and cannot be approved.
 * @module dashboard
 */

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { ClipboardList, Loader2, Check, X, TrendingUp, TrendingDown, Minus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { usePlanning } from "@/hooks/use-planning"
import { useTradeDecision } from "@/hooks/use-trade-decision"
import { useDashboard } from "@/context/dashboard-context"

const MAX_TARGET_PROFIT_PERCENT = 1000

/**
 * @function PlanSection
 * @description Renders the trade-planning workflow: target-profit input,
 *   generate button, and the resulting plan with approve/reject actions.
 *   Asset comes from the DD section's analyzed asset (dashboard context).
 * @returns {JSX.Element} The trade plan card.
 */
export function PlanSection() {
  const cardRef = useRef<HTMLDivElement>(null)
  const { asset, ddReport, tradePlan, setTradePlan, walletAddress } = useDashboard()
  const { loading: planLoading, generatePlan, targetProfitPercent, setTargetProfitPercent } = usePlanning()
  const { approveTrade, rejectTrade, approving, rejecting } = useTradeDecision()

  useGSAP(() => {
    if (!cardRef.current) return
    gsap.fromTo(cardRef.current, {
      y: 30, opacity: 0, filter: "blur(6px)",
    }, {
      y: 0, opacity: 1, filter: "blur(0px)",
      duration: 0.6, ease: "cubic-bezier(0.32, 0.72, 0, 1)", delay: 0.3,
      scrollTrigger: { trigger: cardRef.current, start: "top 85%" },
    })
  }, { scope: cardRef })

  const isNoTrade = tradePlan?.action === "NO_TRADE"
  const targetValid = Number.isFinite(targetProfitPercent)
    && targetProfitPercent > 0
    && targetProfitPercent <= MAX_TARGET_PROFIT_PERCENT

  const handleGenerate = () => {
    if (!asset || !walletAddress || !targetValid) return
    generatePlan(asset, "dashboard-user", walletAddress)
  }

  const handleApprove = async () => {
    if (!tradePlan || !walletAddress) return
    await approveTrade(tradePlan, walletAddress, "dashboard-user", ddReport ?? undefined)
  }

  const handleReject = async () => {
    if (!tradePlan) return
    await rejectTrade(tradePlan, "dashboard-user")
    setTradePlan(null)
  }

  const direction = tradePlan?.side
  const sizeUsd = tradePlan?.position_size_usdc

  return (
    <div ref={cardRef}>
      <div className="bezel-outer">
        <div className="bezel-inner">
          <Card className="border-0 bg-transparent shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base font-medium text-white/90">
                <ClipboardList className="w-4 h-4 text-violet-400" />
                Trade Plan
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!ddReport ? (
                <p className="text-sm text-zinc-500">Run DD first to generate a plan</p>
              ) : !tradePlan ? (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="target-profit" className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">
                      Target profit % — {asset}
                    </label>
                    <Input
                      id="target-profit"
                      type="number"
                      min={0}
                      max={MAX_TARGET_PROFIT_PERCENT}
                      step="any"
                      value={targetProfitPercent}
                      onChange={(e) => setTargetProfitPercent(Number(e.target.value))}
                      placeholder="100"
                      className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-violet-500/50"
                    />
                  </div>
                  <Button
                    onClick={handleGenerate}
                    disabled={planLoading || !walletAddress || !targetValid}
                    className="w-full bg-violet-600 hover:bg-violet-500 text-white cursor-pointer"
                  >
                    {planLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : (
                      <ClipboardList className="w-4 h-4 mr-2" />
                    )}
                    Generate Trade Plan
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {isNoTrade ? (
                        <Badge variant="secondary" className="bg-zinc-500/15 text-zinc-300 border-zinc-500/30 font-mono text-xs">
                          <Minus className="w-3 h-3 mr-1" />
                          NO TRADE
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className={`font-mono text-xs ${
                          direction === "long"
                            ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"
                            : "bg-red-500/15 text-red-400 border-red-500/20"
                        }`}>
                          {direction === "long" ? <TrendingUp className="w-3 h-3 mr-1" /> : <TrendingDown className="w-3 h-3 mr-1" />}
                          {direction?.toUpperCase()}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="bg-white/5 text-zinc-300 border-white/10 font-mono text-xs">
                        {tradePlan.asset}
                      </Badge>
                    </div>
                    {/* reason: NO_TRADE carries a zero-size placeholder position — hide the size */}
                    {!isNoTrade && typeof sizeUsd === "number" && (
                      <span className="text-xs text-zinc-400 font-mono">${sizeUsd.toLocaleString()} USDC</span>
                    )}
                  </div>

                  {isNoTrade ? (
                    <div className="glass rounded-md p-3 border border-amber-500/20 bg-amber-500/5">
                      <p className="text-[10px] text-amber-400 uppercase tracking-wider mb-1">No trade — reason</p>
                      <p className="text-xs text-amber-200/90 leading-relaxed">
                        {tradePlan.reasoning || "Consensus favors standing aside."}
                      </p>
                    </div>
                  ) : (
                    <>
                      {tradePlan.entry_price && (
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div className="glass rounded-md p-2">
                            <span className="text-zinc-500 block">Entry</span>
                            <span className="text-white font-mono">${tradePlan.entry_price.toLocaleString()}</span>
                          </div>
                          <div className="glass rounded-md p-2">
                            <span className="text-zinc-500 block">TP</span>
                            <span className="text-emerald-400 font-mono">${tradePlan.take_profit?.toLocaleString() ?? "—"}</span>
                          </div>
                          <div className="glass rounded-md p-2">
                            <span className="text-zinc-500 block">SL</span>
                            <span className="text-red-400 font-mono">${tradePlan.stop_loss?.toLocaleString() ?? "—"}</span>
                          </div>
                        </div>
                      )}

                      {tradePlan.reasoning && (
                        <p className="text-xs text-zinc-400 leading-relaxed">{tradePlan.reasoning}</p>
                      )}

                      {tradePlan.leverage && (
                        <Badge variant="secondary" className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs">
                          {tradePlan.leverage}x leverage
                        </Badge>
                      )}
                    </>
                  )}

                  <Separator className="bg-white/5" />

                  <div className="flex gap-2">
                    <Button
                      onClick={handleApprove}
                      // reason: a NO_TRADE plan must never reach execution
                      disabled={approving || isNoTrade}
                      className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer"
                    >
                      {approving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Check className="w-4 h-4 mr-2" />}
                      Approve & Execute
                    </Button>
                    <Button
                      onClick={handleReject}
                      disabled={rejecting}
                      variant="destructive"
                      className="flex-1 cursor-pointer"
                    >
                      <X className="w-4 h-4 mr-2" />
                      Reject
                    </Button>
                  </div>
                </div>
              )}

            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
