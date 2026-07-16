import { describe, it, expect } from "vitest"
import { getCategory, getCategoryName, getCoinGeckoId } from "@/lib/asset-categories"

describe("getCategory", () => {
  it("returns major category for BTC", () => {
    const cat = getCategory("BTC")
    expect(cat).not.toBeNull()
    if (cat) {
      expect(cat.name).toBe("major")
      expect(cat.activeFactors).toContain("technical")
      expect(cat.activeFactors).toContain("onchain")
      expect(cat.activeFactors).toContain("sentiment")
      expect(cat.activeFactors).toContain("fundamental")
    }
  })

  it("returns meme category for DOGE", () => {
    const cat = getCategory("DOGE")
    expect(cat).not.toBeNull()
    if (cat) {
      expect(cat.name).toBe("meme")
      expect(cat.activeFactors).toContain("technical")
      expect(cat.activeFactors).toContain("onchain")
      expect(cat.activeFactors).toContain("sentiment")
      expect(cat.activeFactors).not.toContain("fundamental")
    }
  })

  it("returns major (fallback) for unknown asset", () => {
    const cat = getCategory("UNKNOWN")
    expect(cat).not.toBeNull()
    if (cat) {
      expect(cat.name).toBe("major")
    }
  })

  it("returns layer1 for SOL", () => {
    const cat = getCategory("SOL")
    expect(cat).not.toBeNull()
    if (cat) {
      expect(cat.name).toBe("layer1")
    }
  })
})

describe("getCategoryName", () => {
  it("returns 'major' for BTC", () => {
    expect(getCategoryName("BTC")).toBe("major")
  })
  it("returns 'meme' for DOGE", () => {
    expect(getCategoryName("DOGE")).toBe("meme")
  })
  it("returns 'major' (fallback) for unknown", () => {
    expect(getCategoryName("UNKNOWN")).toBe("major")
  })
})

describe("getCoinGeckoId", () => {
  it("returns 'bitcoin' for BTC", () => {
    expect(getCoinGeckoId("BTC")).toBe("bitcoin")
  })
  it("returns 'dogecoin' for DOGE", () => {
    expect(getCoinGeckoId("DOGE")).toBe("dogecoin")
  })
  it("returns null for unknown", () => {
    expect(getCoinGeckoId("ZZZ")).toBeNull()
  })
})
