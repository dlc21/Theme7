import { describe, expect, it } from "vitest"

import { canStartNewHarness, firstAvailableNewHarness, newLaneHarness, orderHarnesses } from "@/lib/harness-policy"
import type { HarnessAvailability } from "@/lib/types"

const harnesses: HarnessAvailability[] = [
  { id: "codex", label: "Codex", supportsGuidance: true, state: "available" },
  { id: "shell", label: "Shell", supportsGuidance: false, state: "available" },
  { id: "omp", label: "OMP", supportsGuidance: true, state: "missing" },
]

describe("new harness policy", () => {
  it("uses exact provider order for each distribution", () => {
    expect(orderHarnesses(harnesses, "stock").map((item) => item.id)).toEqual(["codex", "shell"])
    expect(orderHarnesses(harnesses, "theme-7").map((item) => item.id)).toEqual(["omp", "shell"])
  })

  it("selects the first available provider inside the active boundary", () => {
    expect(canStartNewHarness("codex", "stock")).toBe(true)
    expect(canStartNewHarness("omp", "stock")).toBe(false)
    expect(canStartNewHarness("omp", "theme-7")).toBe(true)
    expect(canStartNewHarness("codex", "theme-7")).toBe(false)
    expect(firstAvailableNewHarness(harnesses, "stock")).toBe("codex")
    expect(firstAvailableNewHarness(harnesses, "theme-7")).toBe("shell")
  })

  it("recovers invalid new-lane defaults to Shell", () => {
    expect(newLaneHarness("omp", "stock")).toBe("shell")
    expect(newLaneHarness("codex", "stock")).toBe("codex")
    expect(newLaneHarness("codex", "theme-7")).toBe("shell")
    expect(newLaneHarness("omp", "theme-7")).toBe("omp")
  })
})
