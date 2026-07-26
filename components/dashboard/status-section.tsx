"use client"

import { useRef, useState } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { Activity, Loader2, CheckCircle2, Clock, XCircle, BarChart3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useOrderStatus } from "@/hooks/use-order-status"
import { useRecordOutcome } from "@/hooks/use-record-outcome"

export function StatusSection() {
  const cardRef = useRef<HTMLDivElement>(null)
  const [oid, setOid] = useState("")
  const { status: statusData, loading: statusLoading, checkStatus } = useOrderStatus()
  const { recordOutcome, loading: outcomeLoading } = useRecordOutcome()

  const [decisionKey, setDecisionKey] = useState("")
  const [result, setResult] = useState<"profit" | "loss" | "breakeven" | "cancelled">("profit")
  const [pnlUsdc, setPnlUsdc] = useState("")
  const [exitReason, setExitReason] = useState("")

  useGSAP(() => {
    if (!cardRef.current) return
    gsap.fromTo(cardRef.current, {
      y: 30, opacity: 0, filter: "blur(6px)",
    }, {
      y: 0, opacity: 1, filter: "blur(0px)",
      duration: 0.6, ease: "cubic-bezier(0.32, 0.72, 0, 1)", delay: 0.5,
      scrollTrigger: { trigger: cardRef.current, start: "top 85%" },
    })
  }, { scope: cardRef })

  const handleCheckStatus = () => {
    if (!oid.trim()) return
    checkStatus(Number(oid))
  }

  const handleRecordOutcome = () => {
    if (!decisionKey.trim()) return
    recordOutcome(decisionKey.trim(), result, {
      pnlUsdc: pnlUsdc ? Number(pnlUsdc) : undefined,
      exitReason: exitReason || undefined,
    })
  }

  const StatusIcon = statusData?.status === "filled" ? CheckCircle2
    : statusData?.status === "pending" ? Clock
    : XCircle

  return (
    <div ref={cardRef}>
      <div className="bezel-outer">
        <div className="bezel-inner">
          <Card className="border-0 bg-transparent shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base font-medium text-white/90">
                <Activity className="w-4 h-4 text-emerald-400" />
                Order Status & Outcome
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Order Status Checker */}
              <div className="space-y-2">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Order Status</p>
                <div className="flex gap-2">
                  <Input
                    value={oid}
                    onChange={(e) => setOid(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCheckStatus()}
                    placeholder="Order ID (oid)"
                    className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-violet-500/50 text-xs"
                  />
                  <Button
                    onClick={handleCheckStatus}
                    disabled={statusLoading || !oid.trim()}
                    size="sm"
                    className="bg-violet-600 hover:bg-violet-500 text-white shrink-0 cursor-pointer"
                  >
                    {statusLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check"}
                  </Button>
                </div>

                {statusData && (
                  <div className="glass rounded-lg p-3 flex items-center gap-3">
                    <StatusIcon className={`w-4 h-4 ${
                      statusData.status === "filled" ? "text-emerald-400" :
                      statusData.status === "pending" ? "text-amber-400" : "text-red-400"
                    }`} />
                    <div className="flex-1">
                      <Badge variant="secondary" className={`text-xs font-mono ${
                        statusData.status === "filled"
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"
                          : statusData.status === "pending"
                            ? "bg-amber-500/15 text-amber-400 border-amber-500/20"
                            : "bg-red-500/15 text-red-400 border-red-500/20"
                      }`}>
                        {statusData.status}
                      </Badge>
                      {statusData.fillAmount != null && (
                        <span className="text-xs text-zinc-400 ml-2 font-mono">
                          fill: {statusData.fillAmount}
                        </span>
                      )}
                      {statusData.fillPrice != null && (
                        <span className="text-xs text-zinc-400 ml-2 font-mono">
                          @ ${statusData.fillPrice.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                )}

              </div>

              <Separator className="bg-white/5" />

              {/* Outcome Recorder */}
              <div className="space-y-2">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider flex items-center gap-1">
                  <BarChart3 className="w-3 h-3" />
                  Record Outcome
                </p>
                <Input
                  value={decisionKey}
                  onChange={(e) => setDecisionKey(e.target.value)}
                  placeholder="Decision key"
                  className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-violet-500/50 text-xs"
                />

                <div className="flex gap-1.5">
                  {(["profit", "loss", "breakeven", "cancelled"] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => setResult(r)}
                      className={`px-2.5 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                        result === r
                          ? r === "profit" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                          : r === "loss" ? "bg-red-500/20 text-red-300 border border-red-500/30"
                          : r === "breakeven" ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                          : "bg-zinc-500/20 text-zinc-300 border border-zinc-500/30"
                          : "bg-white/5 text-zinc-400 border border-transparent hover:bg-white/10"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>

                <Input
                  value={pnlUsdc}
                  onChange={(e) => setPnlUsdc(e.target.value)}
                  placeholder="PnL USDC (optional)"
                  className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-violet-500/50 text-xs"
                />

                <Input
                  value={exitReason}
                  onChange={(e) => setExitReason(e.target.value)}
                  placeholder="Exit reason (optional)"
                  className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-violet-500/50 text-xs"
                />

                <Button
                  onClick={handleRecordOutcome}
                  disabled={outcomeLoading || !decisionKey.trim()}
                  className="w-full bg-violet-600 hover:bg-violet-500 text-white cursor-pointer"
                >
                  {outcomeLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <BarChart3 className="w-4 h-4 mr-2" />}
                  Record Outcome
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
