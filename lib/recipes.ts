import fs from "node:fs/promises"
import path from "node:path"

import { recipesDirectory } from "@/lib/config"
import { isPathInside } from "@/lib/path-containment"
import type { HarnessId } from "@/lib/types"

export type RecipeManifestV1 = {
  schemaVersion: 1
  id: string
  name: string
  summary: string
  prominence: "primary" | "secondary"
  requiresEmptyDirectory: boolean
  suggestedHarness: "auto" | HarnessId
  initialPanes: Array<"terminal" | "files">
  templateDirectory?: string
  firstAgentPrompt: string
  additionalAgentPrompt?: string
}

export type LoadedRecipe = RecipeManifestV1 & {
  source: "builtin" | "local"
  root: string
  templateFiles: string[]
}

const MANIFEST_KEYS = new Set([
  "schemaVersion", "id", "name", "summary", "prominence", "requiresEmptyDirectory",
  "suggestedHarness", "initialPanes", "templateDirectory", "firstAgentPrompt", "additionalAgentPrompt",
])
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HARNESS = new Set(["auto", "omp", "codex", "shell"])
const PANE = new Set(["terminal", "files"])

function builtInRecipesDirectory(): string {
  return path.join(process.cwd(), "recipes", "builtin")
}


export function validateRecipeManifest(value: unknown): RecipeManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recipe manifest must be an object.")
  const input = value as Record<string, unknown>
  const unknown = Object.keys(input).filter((key) => !MANIFEST_KEYS.has(key))
  if (unknown.length) throw new Error(`Unknown recipe fields: ${unknown.join(", ")}.`)
  if (input.schemaVersion !== 1) throw new Error("Recipe schemaVersion must be 1.")
  if (typeof input.id !== "string" || !ID.test(input.id)) throw new Error("Recipe id must be lowercase kebab-case.")
  for (const key of ["name", "summary", "firstAgentPrompt"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`Recipe ${key} is required.`)
  }
  if (input.prominence !== "primary" && input.prominence !== "secondary") throw new Error("Recipe prominence is invalid.")
  if (typeof input.requiresEmptyDirectory !== "boolean") throw new Error("Recipe requiresEmptyDirectory must be boolean.")
  if (typeof input.suggestedHarness !== "string" || !HARNESS.has(input.suggestedHarness)) throw new Error("Recipe suggestedHarness is invalid.")
  if (!Array.isArray(input.initialPanes) || !input.initialPanes.length || input.initialPanes.some((pane) => typeof pane !== "string" || !PANE.has(pane))) {
    throw new Error("Recipe initialPanes may contain only terminal and files.")
  }
  if (input.templateDirectory !== undefined && (typeof input.templateDirectory !== "string" || !input.templateDirectory.trim() || path.isAbsolute(input.templateDirectory) || input.templateDirectory.split(/[\\/]/).includes(".."))) {
    throw new Error("Recipe templateDirectory must be a safe relative path.")
  }
  if (input.additionalAgentPrompt !== undefined && typeof input.additionalAgentPrompt !== "string") throw new Error("Recipe additionalAgentPrompt must be a string.")
  return input as RecipeManifestV1
}

async function listTemplateFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative)
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Recipe templates cannot contain symlinks: ${entry.name}`)
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listTemplateFiles(root, child))
    else if (entry.isFile()) files.push(child)
    else throw new Error(`Unsupported recipe template entry: ${entry.name}`)
  }
  return files.sort()
}

async function loadRecipeFolder(folder: string, source: LoadedRecipe["source"]): Promise<LoadedRecipe> {
  const manifestPath = path.join(folder, "recipe.json")
  const manifest = validateRecipeManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")))
  const templateRoot = manifest.templateDirectory ? path.resolve(folder, manifest.templateDirectory) : null
  if (templateRoot && !isPathInside(folder, templateRoot)) throw new Error(`Recipe ${manifest.id} templateDirectory escapes its folder.`)
  const templateFiles = templateRoot ? await listTemplateFiles(templateRoot) : []
  return { ...manifest, source, root: folder, templateFiles }
}

async function recipeFolders(root: string): Promise<string[]> {
  await fs.mkdir(root, { recursive: true })
  const entries = await fs.readdir(root, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => path.join(root, entry.name)).sort()
}

export async function loadRecipes(): Promise<LoadedRecipe[]> {
  const builtins = await Promise.all((await recipeFolders(builtInRecipesDirectory())).map((folder) => loadRecipeFolder(folder, "builtin")))
  const builtinIds = new Set(builtins.map((recipe) => recipe.id))
  if (builtinIds.size !== builtins.length) throw new Error("Built-in recipe ids must be unique.")
  const locals: LoadedRecipe[] = []
  const seen = new Set(builtinIds)
  for (const folder of await recipeFolders(recipesDirectory())) {
    const recipe = await loadRecipeFolder(folder, "local")
    if (builtinIds.has(recipe.id)) throw new Error(`Local recipe cannot override built-in id ${recipe.id}.`)
    if (seen.has(recipe.id)) throw new Error(`Duplicate recipe id ${recipe.id}.`)
    seen.add(recipe.id)
    locals.push(recipe)
  }
  return [...builtins, ...locals]
}

export async function getRecipe(id: string): Promise<LoadedRecipe | null> {
  return (await loadRecipes()).find((recipe) => recipe.id === id) ?? null
}

export async function recipePrompt(recipeId: string | null, role: "first" | "additional"): Promise<string | undefined> {
  if (!recipeId) return undefined
  const recipe = await getRecipe(recipeId)
  if (!recipe) return undefined
  return role === "first" ? recipe.firstAgentPrompt : recipe.additionalAgentPrompt ?? recipe.firstAgentPrompt
}

async function assertSafeDestinationParents(root: string, target: string): Promise<void> {
  const relative = path.relative(root, path.dirname(target))
  let current = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`Recipe destination contains a symlink: ${path.relative(root, current)}`)
      if (!stat.isDirectory()) throw new Error(`Recipe destination parent is not a directory: ${path.relative(root, current)}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      break
    }
  }
}

export async function applyRecipe(directory: string, recipe: LoadedRecipe): Promise<{ created: string[]; rollback(): Promise<void> }> {
  const entries = await fs.readdir(directory)
  if (recipe.requiresEmptyDirectory && entries.length) throw new Error(`${recipe.name} requires an empty directory.`)
  const templateRoot = recipe.templateDirectory ? path.resolve(recipe.root, recipe.templateDirectory) : null
  const targets = recipe.templateFiles.map((relative) => ({ relative, target: path.resolve(directory, relative) }))
  for (const item of targets) {
    if (!isPathInside(directory, item.target)) throw new Error(`Recipe path escapes the lane: ${item.relative}`)
    await assertSafeDestinationParents(directory, item.target)
    try { await fs.lstat(item.target); throw new Error(`Recipe would overwrite ${item.relative}.`) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const created: string[] = []
  const rollback = async () => {
    for (const file of [...created].reverse()) await fs.rm(file, { force: true })
    const parents = [...new Set(created.map((file) => path.dirname(file)))].sort((a, b) => b.length - a.length)
    for (const parent of parents) if (parent !== directory) await fs.rmdir(parent).catch(() => undefined)
  }
  try {
    for (const item of targets) {
      await fs.mkdir(path.dirname(item.target), { recursive: true })
      await fs.copyFile(path.join(templateRoot!, item.relative), item.target)
      created.push(item.target)
    }
    return { created: recipe.templateFiles, rollback }
  } catch (error) {
    await rollback()
    throw error
  }
}
