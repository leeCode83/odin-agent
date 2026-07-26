"use client"

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { Wallet, TrendingUp, DollarSign, RefreshCw } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useBalance } from "@/hooks/use-balance"
import { useDashboard } from "@/context/dashboard-context"

export function BalanceCard() {
  const cardRef = useRef<HTMLDivElement>(null)
  const { walletAddress } = useDashboard()
  const { balance, loading, fetchBalance } = useBalance(walletAddress)

  useGSAP(() => {
    if (!cardRef.current) return
    gsap.fromTo(cardRef.current, {
      y: 30, opacity: 0, filter: "blur(6px)",
    }, {
      y: 0, opacity: 1, filter: "blur(0px)",
      duration: 0.6, ease: "cubic-bezier(0.32, 0.72, 0, 1)", delay: 0.1,
      scrollTrigger: { trigger: cardRef.current, start: "top 85%" },
    })
  }, { scope: cardRef })

  return (
    <div ref={cardRef}>
      <div className="bezel-outer">
        <div className="bezel-inner">
          <Card className="border-0 bg-transparent shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base font-medium text-white/90">
                <div className="flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-emerald-400" />
                  Balance
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => fetchBalance()}
                  disabled={loading || !walletAddress}
                  className="h-7 px-2 text-zinc-400 hover:text-white cursor-pointer"
                >
                  <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!walletAddress ? (
                <p className="text-sm text-zinc-500">Initialize wallet first</p>
              ) : loading && !balance ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-32 bg-white/5" />
                  <Skeleton className="h-4 w-24 bg-white/5" />
                </div>
              ) : balance ? (
                <>
                  <div>
                    <p className="text-3xl font-bold text-white tracking-tight">
                      ${balance.accountValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className="text-xs text-zinc-500 mt-1">Account Value</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="glass rounded-lg p-3">
                      <div className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1">
                        <DollarSign className="w-3 h-3" />
                        Withdrawable
                      </div>
                      <p className="text-sm font-medium text-white">
                        ${balance.withdrawable.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                    <div className="glass rounded-lg p-3">
                      <div className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1">
                        <TrendingUp className="w-3 h-3" />
                        Margin Used
                      </div>
                      <p className="text-sm font-medium text-white">
                        ${balance.totalMarginUsed.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
