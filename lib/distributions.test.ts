import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ompTheme7 } from "theme-7"
import { runtimeCapabilities, runtimeIdentity, validateReviewedDistribution } from "@/lib/distributions"
import type { ReviewedDistributionPackage } from "@/lib/distributions"

let root = ""
const originalOmp = process.env.OPERATOR_ENGINE_OMP_BIN
const originalDistribution = process.env.OPERATOR_ENGINE_DISTRIBUTION
const originalData = process.env.OPERATOR_ENGINE_DATA_DIR
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-distribution-"))
  process.env.OPERATOR_ENGINE_DATA_DIR = root
  process.env.OPERATOR_ENGINE_OMP_BIN = path.join(root, "missing-omp")
  delete process.env.OPERATOR_ENGINE_DISTRIBUTION
})
afterEach(async () => {
  if (originalOmp === undefined) delete process.env.OPERATOR_ENGINE_OMP_BIN
  else process.env.OPERATOR_ENGINE_OMP_BIN = originalOmp
  if (originalDistribution === undefined) delete process.env.OPERATOR_ENGINE_DISTRIBUTION
  else process.env.OPERATOR_ENGINE_DISTRIBUTION = originalDistribution
  if (originalData === undefined) delete process.env.OPERATOR_ENGINE_DATA_DIR
  else process.env.OPERATOR_ENGINE_DATA_DIR = originalData
  await fs.rm(root, { recursive: true, force: true })
})

describe("reviewed Distributions", () => {
  it("validates the reviewed package and rejects identity drift", async () => {
    await expect(validateReviewedDistribution(ompTheme7 as ReviewedDistributionPackage)).resolves.toBeTruthy()
    const invalid = structuredClone(ompTheme7.distribution)
    invalid.edition.id = "stock"
    await expect(validateReviewedDistribution({ distribution: invalid, resources: ompTheme7.resources } as ReviewedDistributionPackage)).rejects.toThrow("identity")
  })
  it("always exposes the Theme7 application identity", async () => {
    const unavailable = await runtimeCapabilities()
    expect(unavailable.distributionId).toBe("theme-7")
    expect(unavailable.harnesses.find((item) => item.id === "omp")?.state).not.toBe("available")
    expect(unavailable.onboarding?.intro.title).toBe("welcome to Theme7")
    process.env.OPERATOR_ENGINE_DISTRIBUTION = "ignored"
    process.env.OPERATOR_ENGINE_OMP_BIN = process.execPath
    const active = await runtimeCapabilities()
    expect(active.distributionId).toBe("theme-7")
    expect(active.harnesses.find((item) => item.id === "omp")?.state).toBe("available")
    expect(JSON.stringify(active)).not.toContain(process.execPath)
    expect(JSON.stringify(active)).not.toMatch(/executable|prefixArgs|packageRoot|identityExtension|OPERATOR_ENGINE_/)
  })
  it("replaces a removed legacy Edition preference without surfacing an error", async () => {
    await fs.writeFile(path.join(root, "active-edition.json"), JSON.stringify({
      schemaVersion: 1,
      editionId: "omp-special-edition",
      lastEditionId: "omp-special-edition",
    }))
    process.env.OPERATOR_ENGINE_DISTRIBUTION = "theme-7"
    process.env.OPERATOR_ENGINE_OMP_BIN = process.execPath
    const active = await runtimeCapabilities()
    expect(active.edition.activeId).toBe("theme-7")
    expect(active.edition.lastEditionId).toBe("theme-7")
    expect(active.edition.error).toBeUndefined()
  })
  it("validates explicit bounded runtime identity without port semantics", () => {
    const values = {
      OPERATOR_ENGINE_RUNTIME_ROLE: "promoted",
      OPERATOR_ENGINE_RUNTIME_MODE: "standalone",
      OPERATOR_ENGINE_PORT: "4980",
      OPERATOR_ENGINE_TERMINAL_PORT: "4981",
      OPERATOR_ENGINE_DATA_CLASS: "durable",
      OPERATOR_ENGINE_SOURCE_COMMIT: "abcdef1234567890",
      OPERATOR_ENGINE_RELEASE_ID: "daily-20260718",
      OPERATOR_ENGINE_CONTENT_SHA256: "a".repeat(64),
    }
    Object.assign(process.env, values)
    try {
      expect(runtimeIdentity("theme-7")).toEqual({
        sourceCommit: "abcdef1234567890", distribution: "theme-7", role: "promoted", mode: "standalone",
        webPort: 4980, terminalPort: 4981, dataClass: "durable", releaseId: "daily-20260718", contentSha256: "a".repeat(64),
      })
      process.env.OPERATOR_ENGINE_PORT = "0"
      expect(() => runtimeIdentity("theme-7")).toThrow("Invalid OPERATOR_ENGINE_PORT")
    } finally {
      for (const key of Object.keys(values)) delete process.env[key]
    }
  })

})
