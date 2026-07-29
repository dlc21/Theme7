import { describe, expect, it } from "vitest"
import { runRecoveryProof } from "./prove-recovery"

describe("prove-recovery", () => {
  it("rejects running without --container argument", async () => {
    await expect(runRecoveryProof([])).rejects.toThrow("Usage: prove-recovery")
  })

  it("rejects running with wrong container name", async () => {
    await expect(runRecoveryProof(["--container", "wrong-container-name"])).rejects.toThrow(
      "Only container theme7-theme7-1 is accepted"
    )
  })
})
