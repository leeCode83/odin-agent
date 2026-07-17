import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Database } from "arangojs"

const { mockDatabaseInstance } = vi.hoisted(() => ({
  mockDatabaseInstance: {
    collection: vi.fn(),
    query: vi.fn(),
    graph: vi.fn(),
  },
}))

vi.mock("arangojs", () => ({
  Database: vi.fn().mockImplementation(function () { return mockDatabaseInstance }),
}))

const mockDb = mockDatabaseInstance as unknown as Database

beforeEach(() => {
  vi.clearAllMocks()
})

describe("createArangoClient", () => {
  it("creates a Database instance with default env vars", async () => {
    const { createArangoClient } = await import("@/lib/db/arango-client")
    const db = createArangoClient()
    expect(db).toBe(mockDatabaseInstance)
  })
})

describe("getDb", () => {
  it("returns a Database instance on success", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    const db = getDb()
    expect(db).toBe(mockDatabaseInstance)
  })

  it("caches the Database instance across calls", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    const db1 = getDb()
    const db2 = getDb()
    expect(db1).toBe(db2)
  })
})

describe("getGraph", () => {
  it("returns a graph instance by name", async () => {
    const { getGraph } = await import("@/lib/db/arango-client")
    const fakeGraph = { name: "odin_graph" }
    mockDatabaseInstance.graph.mockReturnValue(fakeGraph)

    const result = getGraph(mockDb)
    expect(mockDatabaseInstance.graph).toHaveBeenCalledWith("odin_graph")
    expect(result).toBe(fakeGraph)
  })

  it("returns null on error", async () => {
    const { getGraph } = await import("@/lib/db/arango-client")
    mockDatabaseInstance.graph.mockImplementation(() => { throw new Error("fail") })

    const result = getGraph(mockDb)
    expect(result).toBeNull()
  })
})
