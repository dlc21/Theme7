import { describe, expect, it } from "vitest"

import type { TerminalShowpiecePublicV1 } from "@/lib/editions"
import { STOCK_TERMINAL_SHOWPIECES, terminalShowpieceAt, terminalShowpieceCatalog } from "@/lib/terminal-showpiece"

const packageCatalog: TerminalShowpiecePublicV1 = {
  version: 1,
  mode: "append",
  experiences: [{ id: "package-proof", durationMs: 5600, primitives: [{ kind: "ring", x: 500, y: 500, size: 80, atMs: 0, durationMs: 800, tone: "strong" }] }],
}

describe("terminal showpiece catalog", () => {
  it("keeps the stock order and exact durations", () => {
    expect(STOCK_TERMINAL_SHOWPIECES.map(({ id, durationMs }) => [id, durationMs])).toEqual([
      ["pip-network", 5200], ["signal-relay", 4600], ["constellation", 5000], ["cascade", 4400], ["handshake", 4800], ["thread-weave", 5400],
    ])
    expect(STOCK_TERMINAL_SHOWPIECES.every(({ primitives }) => primitives.length <= 48)).toBe(true)
  })

  it("appends or replaces with reviewed package recipes", () => {
    expect(terminalShowpieceCatalog(packageCatalog).map(({ id }) => id)).toEqual([...STOCK_TERMINAL_SHOWPIECES.map(({ id }) => id), "package-proof"])
    expect(terminalShowpieceCatalog({ ...packageCatalog, mode: "replace" }).map(({ id }) => id)).toEqual(["package-proof"])
    expect(terminalShowpieceCatalog().map(({ id }) => id)).toEqual(STOCK_TERMINAL_SHOWPIECES.map(({ id }) => id))
  })

  it("rotates deterministically and falls back for invalid indexes", () => {
    const catalog = terminalShowpieceCatalog({ ...packageCatalog, mode: "replace" })
    expect(terminalShowpieceAt(catalog, 0).id).toBe("package-proof")
    expect(terminalShowpieceAt(STOCK_TERMINAL_SHOWPIECES, 7).id).toBe("signal-relay")
    expect(terminalShowpieceAt(STOCK_TERMINAL_SHOWPIECES, -1).id).toBe("pip-network")
    expect(terminalShowpieceAt(STOCK_TERMINAL_SHOWPIECES, Number.NaN).id).toBe("pip-network")
    expect(() => terminalShowpieceAt([], 0)).toThrow("must not be empty")
  })
})
