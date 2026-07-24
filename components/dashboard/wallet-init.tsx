"use client"

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { KeyRound, CheckCircle2, Loader2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useInitWallet } from "@/hooks/use-init-wallet"
import { useDashboard } from "@/context/dashboard-context"

export function WalletInit() {
  const cardRef = useRef<HTMLDivElement>(null)
  const { initWallet, result: data, loading } = useInitWallet()
  const { walletAddress } = useDashboard()

  useGSAP(() => {
    if (!cardRef.current) return
    gsap.fromTo(cardRef.current, {
      y: 30, opacity: 0, filter: "blur(6px)",
    }, {
      y: 0, opacity: 1, filter: "blur(0px)",
      duration: 0.6, ease: "cubic-bezier(0.32, 0.72, 0, 1)",
      scrollTrigger: { trigger: cardRef.current, start: "top 85%" },
    })
  }, { scope: cardRef })

  const isInit = walletAddress || data?.approved

  return (
    <div ref={cardRef}>
      <div className="bezel-outer">
        <div className="bezel-inner">
          <Card className="border-0 bg-transparent shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base font-medium text-white/90">
                <KeyRound className="w-4 h-4 text-violet-400" />
                Agent Wallet
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isInit ? (
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-sm text-emerald-400">Initialized</span>
                  <Badge variant="secondary" className="ml-auto text-xs font-mono bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                    {(walletAddress ?? data?.agentAddress ?? "").slice(0, 8)}...
                  </Badge>
                </div>
              ) : (
                <Button
                  onClick={() => initWallet()}
                  disabled={loading}
                  className="w-full bg-violet-600 hover:bg-violet-500 text-white cursor-pointer"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <KeyRound className="w-4 h-4 mr-2" />
                  )}
                  Initialize Agent Wallet
                </Button>
              )}

              {data?.message && !data?.approved && (
                <Alert className="bg-amber-500/10 border-amber-500/20">
                  <AlertCircle className="h-4 w-4 text-amber-400" />
                  <AlertDescription className="text-xs text-amber-300">
                    {data.message}
                  </AlertDescription>
                </Alert>
              )}

            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
