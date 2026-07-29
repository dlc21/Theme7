import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { applyRecipe, loadRecipes, validateRecipeManifest, type LoadedRecipe } from "@/lib/recipes"

const temporary: string[] = []
afterEach(async () => {
  delete process.env.OPERATOR_ENGINE_DATA_DIR
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-recipe-"))
  temporary.push(directory)
  return directory
}

describe("recipes", () => {
  it("rejects traversal and unknown executable fields", () => {
    expect(() => validateRecipeManifest({ schemaVersion: 1, id: "bad", name: "Bad", summary: "Bad", prominence: "primary", requiresEmptyDirectory: false, suggestedHarness: "auto", initialPanes: ["terminal"], templateDirectory: "../escape", firstAgentPrompt: "Ask.", installCommand: "nope" })).toThrow()
  })

  it("discovers a valid local data-only recipe", async () => {
    const data = await temp()
    process.env.OPERATOR_ENGINE_DATA_DIR = data
    const folder = path.join(data, "recipes", "local-one")
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, "recipe.json"), JSON.stringify({ schemaVersion: 1, id: "local-one", name: "Local One", summary: "Local", prominence: "secondary", requiresEmptyDirectory: false, suggestedHarness: "shell", initialPanes: ["terminal"], firstAgentPrompt: "Ask first." }))
    expect((await loadRecipes()).some((recipe) => recipe.id === "local-one" && recipe.source === "local")).toBe(true)
  })

  it("preflights collisions without overwriting", async () => {
    const root = await temp()
    const template = path.join(root, "template")
    const destination = path.join(root, "destination")
    await fs.mkdir(template); await fs.mkdir(destination)
    await fs.writeFile(path.join(template, "README.md"), "new")
    await fs.writeFile(path.join(destination, "README.md"), "existing")
    const recipe: LoadedRecipe = { schemaVersion: 1, id: "collision", name: "Collision", summary: "Collision", prominence: "secondary", requiresEmptyDirectory: false, suggestedHarness: "auto", initialPanes: ["terminal"], templateDirectory: "template", firstAgentPrompt: "Ask.", source: "local", root, templateFiles: ["README.md"] }
    await expect(applyRecipe(destination, recipe)).rejects.toThrow("overwrite")
    expect(await fs.readFile(path.join(destination, "README.md"), "utf8")).toBe("existing")
  })

  it("rejects a destination parent symlink", async () => {
    const root = await temp()
    const template = path.join(root, "template")
    const destination = path.join(root, "destination")
    const outside = path.join(root, "outside")
    await fs.mkdir(path.join(template, "linked"), { recursive: true })
    await fs.mkdir(destination); await fs.mkdir(outside)
    await fs.writeFile(path.join(template, "linked", "OUT.md"), "must stay contained")
    await fs.symlink(outside, path.join(destination, "linked"), process.platform === "win32" ? "junction" : "dir")
    const recipe: LoadedRecipe = { schemaVersion: 1, id: "symlink", name: "Symlink", summary: "Symlink", prominence: "secondary", requiresEmptyDirectory: false, suggestedHarness: "auto", initialPanes: ["terminal"], templateDirectory: "template", firstAgentPrompt: "Ask.", source: "local", root, templateFiles: ["linked/OUT.md"] }
    await expect(applyRecipe(destination, recipe)).rejects.toThrow("symlink")
    await expect(fs.stat(path.join(outside, "OUT.md"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("applies the builtin software-project recipe with native omp context", async () => {
    const destination = await temp()
    const recipe = (await loadRecipes()).find((entry) => entry.id === "software-project")
    expect(recipe).toBeDefined()
    expect(recipe!.templateFiles).toEqual(expect.arrayContaining([
      "AGENTS.md",
      "NOW.md",
      ".omp/AGENTS.md",
      ".omp/RULES.md",
      "README.md",
      "ARCHITECTURE.md",
      "BACKLOG.md",
      "DECISIONS.md",
    ]))
    expect(recipe!.additionalAgentPrompt).toContain("NOW.md")
    expect(recipe!.additionalAgentPrompt).toContain(".omp/AGENTS.md")
    expect(recipe!.additionalAgentPrompt).toContain(".omp/RULES.md")
    expect(recipe!.firstAgentPrompt).toContain("Interview the operator")

    const result = await applyRecipe(destination, recipe!)
    expect(result.created).toEqual(expect.arrayContaining([
      "AGENTS.md",
      "NOW.md",
      ".omp/AGENTS.md",
      ".omp/RULES.md",
    ]))

    const rootAgents = await fs.readFile(path.join(destination, "AGENTS.md"), "utf8")
    const now = await fs.readFile(path.join(destination, "NOW.md"), "utf8")
    const ompAgents = await fs.readFile(path.join(destination, ".omp", "AGENTS.md"), "utf8")
    const ompRules = await fs.readFile(path.join(destination, ".omp", "RULES.md"), "utf8")

    expect(rootAgents).toContain("NOW.md")
    expect(rootAgents).toContain(".omp/AGENTS.md")
    expect(now).toContain("## Current milestone")
    expect(now).toContain("## Next actions")
    expect(now).toContain("## Blockers")
    expect(ompAgents).toContain("## Read order")
    expect(ompAgents).toContain("Ordinary repository files and Git")
    expect(ompRules).toContain("Never commit secrets")
    expect(ompRules).toContain("observed proof")

    await expect(applyRecipe(destination, recipe!)).rejects.toThrow("empty directory")
    expect(await fs.readFile(path.join(destination, "NOW.md"), "utf8")).toBe(now)
  })
})
