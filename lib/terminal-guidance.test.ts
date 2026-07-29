import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { terminalGuidance } from "@/lib/terminal-guidance"

let dataRoot = ""
beforeEach(async () => { dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-guidance-")); process.env.OPERATOR_ENGINE_DATA_DIR = dataRoot })
afterEach(async () => { delete process.env.OPERATOR_ENGINE_DATA_DIR; await fs.rm(dataRoot, { recursive: true, force: true }) })

describe("terminal recipe guidance", () => {
  it("uses the selected Recipe when guidance is requested", async () => {
    const result = await terminalGuidance({ recipeId: "software-project", role: "first", harnessId: "codex", requested: true })
    expect(result.source).toBe("recipe")
    expect(result.prompt).toContain("Interview the operator")
  })

  it("sends no prompt unless explicitly requested", async () => {
    expect(await terminalGuidance({ recipeId: "software-project", role: "first", harnessId: "codex", requested: false })).toEqual({ source: null })
  })

  it("never gives Shell a synthetic prompt", async () => {
    expect(await terminalGuidance({ recipeId: "software-project", role: "first", harnessId: "shell", requested: true })).toEqual({ source: null })
  })
})
