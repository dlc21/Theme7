import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { DistributionProvider, useDistribution } from "@/components/distribution-provider"
const runtimeIdentity = { sourceCommit: null, distribution: "stock", role: "development", mode: "hmr", webPort: 4400, terminalPort: 4401, dataClass: "isolated", releaseId: null, contentSha256: null } as const

describe("DistributionProvider", () => {
  it("uses the quiet stock presentation", () => {
    function StockPresentation() {
      const edition = useDistribution()
      return createElement("div", null, `${edition.productName} — ${edition.subtitle}`)
    }
    const html = renderToStaticMarkup(
      createElement(DistributionProvider, {
        initial: { harnesses: [], distributionId: "stock", runtimeIdentity, edition: { active: null, activeId: "stock", locked: false, editions: [] } },
        children: createElement(StockPresentation),
      }),
    )
    expect(html).toContain("Operator Engine — Local client")
  })

  it("fails closed when an authoritative Edition is unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(DistributionProvider, {
        initial: { harnesses: [], distributionId: "stock", runtimeIdentity, edition: { active: null, activeId: "stock", locked: true, editions: [], error: "Required Edition is invalid." } },
        children: createElement("div", null, "stock interface"),
      }),
    )

    expect(html).toContain("This product could not start")
    expect(html).toContain("Your folders and files were not changed.")
    expect(html).toContain("Required Edition is invalid.")
    expect(html).not.toContain("stock interface")
  })
})
