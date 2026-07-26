"use client"

import { useRef, useState } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { Zap, Loader2, XCircle, StopCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useExecution } from "@/hooks/use-execution"
import { useDashboard } from "@/context/dashboard-context"

export function ExecSection() {
  const cardRef = useRef<HTMLDivElement>(null)
  const [closeCoinInput, setCloseCoinInput] = useState("")
  const { walletAddress, tradePlan } = useDashboard()
  const { executePlan, cancelAll, closeAll, closeCoin, executing, cancelling, closing } = useExecution()

  useGSAP(() => {
    if (!cardRef.current) return
    gsap.fromTo(cardRef.current, {
      y: 30, opacity: 0, filter: "blur(6px)",
    }, {
      y: 0, opacity: 1, filter: "blur(0px)",
      duration: 0.6, ease: "cubic-bezier(0.32, 0.72, 0, 1)", delay: 0.4,
      scrollTrigger: { trigger: cardRef.current, start: "top 85%" },
    })
  }, { scope: cardRef })

  return (
    <div ref={cardRef}>
      <div className="bezel-outer">
        <div className="bezel-inner">
          <Card className="border-0 bg-transparent shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base font-medium text-white/90">
                <Zap className="w-4 h-4 text-amber-400" />
                Execution Controls
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!walletAddress ? (
                <p className="text-sm text-zinc-500">Initialize wallet first</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      onClick={() => executePlan(tradePlan!, walletAddress, "dashboard-user")}
                      disabled={executing || !tradePlan}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer"
                    >
                      {executing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
                      Execute
                    </Button>
                    <Button
                      onClick={() => cancelAll()}
                      disabled={cancelling}
                      variant="destructive"
                      className="cursor-pointer"
                    >
                      <StopCircle className="w-4 h-4 mr-2" />
                      Cancel All
                    </Button>
                  </div>

                  <Button
                    onClick={() => closeAll(walletAddress)}
                    disabled={closing}
                    variant="outline"
                    className="w-full border-white/10 text-red-400 hover:bg-red-500/10 hover:text-red-300 cursor-pointer"
                  >
                    <XCircle className="w-4 h-4 mr-2" />
                    Close All Positions
                  </Button>

                  <div className="flex gap-2">
                    <Input
                      value={closeCoinInput}
                      onChange={(e) => setCloseCoinInput(e.target.value.toUpperCase())}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && closeCoinInput.trim()) {
                          closeCoin(closeCoinInput.trim(), walletAddress)
                        }
                      }}
                      placeholder="Coin (e.g. BTC)"
                      className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-red-500/50 text-xs"
                    />
                    <Button
                      onClick={() => {
                        if (closeCoinInput.trim()) closeCoin(closeCoinInput.trim(), walletAddress)
                      }}
                      disabled={closing || !closeCoinInput.trim()}
                      variant="outline"
                      size="sm"
                      className="border-red-500/30 text-red-400 hover:bg-red-500/10 shrink-0 cursor-pointer"
                    >
                      Close
                    </Button>
                  </div>
                </>
              )}

            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
