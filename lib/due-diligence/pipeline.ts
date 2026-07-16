import { getCategory, getCategoryName } from "@/lib/asset-categories"
import { fetchAllRawData } from "@/lib/data/providers"
import { analyzeSection, synthesizeSections } from "@/lib/agent/llm"
import type { DDPipelineInput, DDPipelineOutput, DDReport, Factor, SectionResult } from "@/lib/agent/types"

const ALL_FACTORS: Factor[] = ["technical", "onchain", "sentiment", "fundamental"]

function emptySection(): SectionResult {
  return { score: null, summary: null, signals: [] }
}

export async function runDDPipeline(input: DDPipelineInput): Promise<DDPipelineOutput> {
  const t0 = Date.now()

  const category = getCategory(input.asset)
  if (!category) {
    throw new Error(`Unknown asset: ${input.asset}`)
  }

  const fetchStart = Date.now()
  const rawData = await fetchAllRawData(input.asset, category)
  const fetchMs = Date.now() - fetchStart

  const llmStart = Date.now()
  const sectionPromises = category.activeFactors.map((factor) =>
    analyzeSection(factor, (rawData as unknown as Record<string, unknown>)[factor])
  )
  const sectionResults = await Promise.all(sectionPromises)

  const sections: Record<Factor, SectionResult> = {
    technical: emptySection(),
    onchain: emptySection(),
    sentiment: emptySection(),
    fundamental: emptySection(),
  }
  category.activeFactors.forEach((factor, i) => {
    sections[factor] = sectionResults[i]
  })

  const { thesis, confidence, flags, errors } = await synthesizeSections(
    input.asset,
    category.name,
    sections
  )
  const llmMs = Date.now() - llmStart

  const report: DDReport = {
    asset: input.asset,
    category: getCategoryName(input.asset),
    timestamp: new Date().toISOString(),
    sections,
    aggregated_thesis: thesis,
    confidence_score: confidence,
    risk_flags: flags,
    errors: errors.length > 0 ? errors : undefined,
  }

  return {
    report,
    timing: { fetchMs, llmMs, totalMs: Date.now() - t0 },
  }
}
