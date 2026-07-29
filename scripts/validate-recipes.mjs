import fs from "node:fs"
import path from "node:path"

const roots = [path.resolve("recipes", "builtin"), path.resolve("examples", "recipes")]
const ids = new Set()
const allowedHarnesses = new Set(["auto", "omp", "codex", "shell"])
const allowedPanes = new Set(["terminal", "files"])

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink rejected: ${child}`)
    if (entry.isDirectory()) walk(child)
  }
}

for (const root of roots) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const folder = path.join(root, entry.name)
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, "recipe.json"), "utf8"))
    if (manifest.schemaVersion !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id)) throw new Error(`Invalid manifest in ${folder}`)
    if (ids.has(manifest.id)) throw new Error(`Duplicate recipe id ${manifest.id}`)
    ids.add(manifest.id)
    if (!allowedHarnesses.has(manifest.suggestedHarness)) throw new Error(`Unknown harness in ${manifest.id}`)
    if (!Array.isArray(manifest.initialPanes) || !manifest.initialPanes.length || manifest.initialPanes.some((pane) => !allowedPanes.has(pane))) throw new Error(`Unknown pane in ${manifest.id}`)
    if (!manifest.name || !manifest.summary || !manifest.firstAgentPrompt) throw new Error(`Incomplete recipe ${manifest.id}`)
    if (manifest.templateDirectory) {
      if (path.isAbsolute(manifest.templateDirectory) || manifest.templateDirectory.split(/[\\/]/).includes("..")) throw new Error(`Traversal in ${manifest.id}`)
      walk(path.join(folder, manifest.templateDirectory))
    }
  }
}
process.stdout.write(`Validated ${ids.size} built-in and example recipes.\n`)
