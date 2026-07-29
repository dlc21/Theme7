import { afterEach, describe, expect, it, vi } from "vitest"

import {
  checkPublicSurface,
  collectStockSurfaceFindings,
  scanStockSurfaceFile,
  stockSurfaceFiles,
} from "./check-public-surface.mjs"

const cleanStock = `
const product = "Operator Engine"
const browser = "Browser"
`

function sources(overrides = {}) {
  return Object.fromEntries(stockSurfaceFiles.map((relative) => [relative, overrides[relative] ?? cleanStock]))
}

afterEach(() => vi.restoreAllMocks())

describe("stock brand boundary", () => {
  it("accepts the reviewed stock UI surface", () => {
    const reviewed = sources()
    expect(collectStockSurfaceFindings(reviewed)).toEqual([])
    expect(checkPublicSurface(reviewed)).toEqual({ fileCount: stockSurfaceFiles.length })
  })

  it.each([
    [["Oh ", "My Pi"].join(""), "components/app-sidebar.tsx"],
    [["Theme ", "Seven"].join(""), "components/workbench.tsx"],
    [["T", "4"].join(""), "components/pane-registry.tsx"],
    [["hosted ", "platform"].join(""), "components/lane-settings.tsx"],
    [["release ", "train"].join(""), "components/directory-picker.tsx"],
    [["Act", "ivity"].join(""), "components/pane-registry.tsx"],
    [["Session ", "History"].join(""), "components/workbench.tsx"],
  ])("rejects integration-only stock copy %s", (sentinel, relative) => {
    const findings = collectStockSurfaceFindings(sources({ [relative]: `label: ${JSON.stringify(sentinel)}` }))
    expect(findings).toEqual([expect.objectContaining({ category: "stock-brand-boundary", path: relative, line: 1 })])
    expect(() => checkPublicSurface(sources({ [relative]: sentinel }))).toThrow("Stock surface exposes integration-only concepts")
  })

  it("does not apply the boundary to reviewed integration modules", () => {
    expect(stockSurfaceFiles).not.toContain("components/terminal-pane.tsx")
    expect(stockSurfaceFiles).not.toContain("components/t4-code-pane.tsx")
    expect(scanStockSurfaceFile("components/terminal-pane.tsx", ["OM", "P"].join(""))).toHaveLength(1)
  })

  it("does not execute the CLI when imported", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.resetModules()
    await expect(import("./check-public-surface.mjs")).resolves.toBeDefined()
    expect(stdout).not.toHaveBeenCalled()
  })
})
