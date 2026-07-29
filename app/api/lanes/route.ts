import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { NextResponse } from "next/server"

import { defaultLayout } from "@/lib/bento-layout"
import { createLane, listLanes } from "@/lib/db"
import { activeReviewedDistribution } from "@/lib/distributions"
import { initializeGitRepository } from "@/lib/git"
import { newLaneHarness } from "@/lib/harness-policy"
import { applyRecipe, getRecipe } from "@/lib/recipes"
import type { HarnessId } from "@/lib/types"
import { resolveWorkspaceDirectory } from "@/lib/workspace"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json({ lanes: listLanes() }, { headers: { "cache-control": "no-store" } })
}

export async function POST(request: Request) {
  let rollbackRecipe: (() => Promise<void>) | undefined
  let removeGit = false
  let directory = ""
  let starterDirectory = ""
  let starterEntry: string | undefined
  try {
    const body = (await request.json()) as {
      path?: string
      rootId?: string
      name?: string
      recipeId?: string | null
      defaultHarness?: HarnessId
      initializeGit?: boolean
      existingFolderUnchanged?: boolean
      distributionId?: "theme-7"
      starterId?: "browser-showpiece"
    }
    const reviewed = await activeReviewedDistribution()
    const distributionId = reviewed?.distribution.id ?? "stock"
    directory = await resolveWorkspaceDirectory(body.path ?? "", body.rootId)
    const name = body.name?.trim() || path.basename(directory)
    const defaultHarness: HarnessId = newLaneHarness(body.defaultHarness, distributionId)
    const recipe = await getRecipe(body.existingFolderUnchanged ? "existing-folder" : body.recipeId ?? "blank")
    if (!recipe) throw new Error("Recipe not found.")

    const applied = await applyRecipe(directory, recipe)
    rollbackRecipe = applied.rollback
    if (body.distributionId !== undefined || body.starterId !== undefined) {
      if (!reviewed || body.distributionId !== reviewed.distribution.id || body.starterId !== reviewed.distribution.starter?.id) throw new Error("The requested starter is unavailable.")
      const starter = reviewed.distribution.starter
      if (!starter || body.starterId !== "browser-showpiece") throw new Error("The requested starter is unavailable.")
      const source = fileURLToPath(reviewed.resources.starters[body.starterId])
      const base = starter.directoryBase
      for (let suffix = 1; ; suffix += 1) {
        const name = suffix === 1 ? base : `${base}-${suffix}`
        const candidate = path.join(directory, name)
        try { await fs.mkdir(candidate); starterDirectory = candidate; starterEntry = `${name}/${starter.entry}`; break }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause }
      }
      await fs.cp(source, starterDirectory, { recursive: true, force: false })
    }
    if (body.initializeGit) {
      const git = await initializeGitRepository(directory)
      removeGit = git.created
    }
    const layout = {
      schemaVersion: 1 as const,
      tree: defaultLayout(recipe.initialPanes),
    }
    const lane = createLane({
      name,
      path: directory,
      layout,
      recipeId: recipe.id,
      recipeVersion: recipe.schemaVersion,
      defaultHarness,
    })
    return NextResponse.json({ lane, ...(starterEntry ? { starter: { entry: starterEntry } } : {}) }, { status: 201 })
  } catch (error) {
    if (starterDirectory) await fs.rm(starterDirectory, { recursive: true, force: true }).catch(() => undefined)
    if (removeGit && directory) await fs.rm(path.join(directory, ".git"), { recursive: true, force: true }).catch(() => undefined)
    await rollbackRecipe?.().catch(() => undefined)
    const message = error instanceof Error ? error.message : "Unable to create lane."
    const duplicate = message.includes("UNIQUE constraint failed")
    return NextResponse.json({ error: duplicate ? "That directory already has a lane." : message }, { status: duplicate ? 409 : 400 })
  }
}
