"use client"

import { useState } from "react"

export default function Home() {
  const [asset, setAsset] = useState("BTC")
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function runDD() {
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch("/api/agent/dd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset, userId: "demo" }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || "Request failed")
      } else {
        setResult(json)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-6 p-8 font-sans">
      <h1 className="text-2xl font-bold">Odin — DD Agent</h1>

      <div className="flex items-center gap-3">
        <label htmlFor="asset" className="font-medium">Asset:</label>
        <input
          id="asset"
          value={asset}
          onChange={(e) => setAsset(e.target.value.toUpperCase())}
          className="border rounded px-3 py-1.5 w-24 text-center uppercase"
          placeholder="BTC"
        />
        <button
          onClick={runDD}
          disabled={loading}
          className="bg-blue-600 text-white rounded px-4 py-1.5 font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Running..." : "Run DD"}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-4 w-full max-w-2xl">
          <p className="text-red-700 font-medium">Error</p>
          <pre className="text-red-600 text-sm mt-1 whitespace-pre-wrap">{error}</pre>
        </div>
      )}

      {result ? (
        <div className="bg-zinc-50 border rounded p-4 w-full max-w-2xl">
          <p className="text-zinc-500 text-xs mb-2">
            fetch: {(result as Record<string, any>).timing?.fetchMs}ms &middot;
            llm: {(result as Record<string, any>).timing?.llmMs}ms &middot;
            total: {(result as Record<string, any>).timing?.totalMs}ms
          </p>
          <pre className="text-sm overflow-x-auto">{JSON.stringify(result, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  )
}
