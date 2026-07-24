"use client"

import { useRef, useState } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { Search, Loader2, AlertCircle, FileSearch, TrendingUp, TrendingDown, Minus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useDD } from "@/hooks/use-dd"
import { useDashboard } from "@/context/dashboard-context"

const POPULAR_ASSETS = ["BTC", "ETH", "SOL", "ARB", "DOGE", "WIF", "PEPE", "HYPE"]

export function DDSection() {
  const cardRef = useRef<HTMLDivElement>(null)
  const [asset, setAsset] = useState("")
  const { ddReport, setDDReport, walletAddress } = useDashboard()
  const { loading, runDD } = useDD()

  useGSAP(() => {
    if (!cardRef.current) return
    gsap.fromTo(cardRef.current, {
      y: 30, opacity: 0, filter: "blur(6px)",
    }, {
      y: 0, opacity: 1, filter: "blur(0px)",
      duration: 0.6, ease: "cubic-bezier(0.32, 0.72, 0, 1)", delay: 0.2,
      scrollTrigger: { trigger: cardRef.current, start: "top 85%" },
    })
  }, { scope: cardRef })

  const handleRunDD = async () => {
    if (!asset.trim()) return
    const result = await runDD(asset.trim().toUpperCase(), walletAddress ?? "anonymous")
    if (result) setDDReport(result)
  }

  const handleAssetClick = (a: string) => {
    setAsset(a)
  }


  const sentimentScore = ddReport?.sections?.sentiment?.score
  const SentimentIcon = sentimentScore != null && sentimentScore > 60 ? TrendingUp
    : sentimentScore != null && sentimentScore < 40 ? TrendingDown
    : Minus
  const sentimentColor = sentimentScore != null && sentimentScore > 60 ? "text-emerald-400"
    : sentimentScore != null && sentimentScore < 40 ? "text-red-400"
    : "text-zinc-400"

  return (
    <div ref={cardRef}>
      <div className="bezel-outer">
        <div className="bezel-inner">
          <Card className="border-0 bg-transparent shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base font-medium text-white/90">
                <FileSearch className="w-4 h-4 text-violet-400" />
                Due Diligence
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <Input
                    value={asset}
                    onChange={(e) => setAsset(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && handleRunDD()}
                    placeholder="e.g. BTC, ETH, SOL"
                    className="pl-9 bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-violet-500/50"
                  />
                </div>
                <Button
                  onClick={handleRunDD}
                  disabled={loading || !asset.trim()}
                  className="bg-violet-600 hover:bg-violet-500 text-white shrink-0 cursor-pointer"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Run DD"}
                </Button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {POPULAR_ASSETS.map((a) => (
                  <Tooltip key={a}>
                    <TooltipTrigger
                      onClick={() => handleAssetClick(a)}
                      className={`px-2.5 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                        asset === a
                          ? "bg-violet-500/20 text-violet-300 border border-violet-500/30"
                          : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white border border-transparent"
                      }`}
                    >
                      {a}
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Run DD on {a}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>


              {ddReport && (
                <div className="space-y-3 mt-2">
                  <Separator className="bg-white/5" />
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="bg-violet-500/15 text-violet-300 border-violet-500/20 font-mono">
                        {ddReport.asset}
                      </Badge>
                      <div className={`flex items-center gap-1 text-xs ${sentimentColor}`}>
                        <SentimentIcon className="w-3 h-3" />
                        <span>Score: {sentimentScore ?? "—"}</span>
                      </div>
                    </div>
                    <span className="text-[10px] text-zinc-600 font-mono">
                      {new Date(ddReport.timestamp).toLocaleTimeString()}
                    </span>
                  </div>

                  <p className="text-xs text-zinc-400 leading-relaxed">{ddReport.summary ?? ddReport.aggregated_thesis}</p>

                  {(ddReport.overallConfidence ?? ddReport.confidence_score) > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Confidence</span>
                      <Badge variant="secondary" className={`text-xs ${
                        (ddReport.overallConfidence ?? ddReport.confidence_score) >= 70
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"
                          : (ddReport.overallConfidence ?? ddReport.confidence_score) >= 40
                            ? "bg-amber-500/15 text-amber-400 border-amber-500/20"
                            : "bg-red-500/15 text-red-400 border-red-500/20"
                      }`}>
                        {ddReport.overallConfidence ?? ddReport.confidence_score}%
                      </Badge>
                    </div>
                  )}

                  {ddReport.risk_flags.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Risk Flags</p>
                      {ddReport.risk_flags.map((f, i) => (
                        <div key={i} className="glass rounded-md px-3 py-2 text-xs text-red-300/80">
                          {f}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
