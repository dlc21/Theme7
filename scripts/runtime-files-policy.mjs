import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const CONTAINER_RUNTIME_FILES = Object.freeze([
  "LICENSE",
  "proxy.ts",
  "scripts/artifact-policy.mjs",
  "scripts/bin/operator-engine",
  "scripts/distribution-adapters.mjs",
  "scripts/harness-adapters.mjs",
  "scripts/layout-tree-policy.mjs",
  "scripts/operator-engine.mjs",
  "scripts/path-policy.mjs",
  "scripts/run.mjs",
  "scripts/runtime-config-core.mjs",
  "scripts/runtime-identity-policy.mjs",
  "scripts/state-io.mjs",
  "scripts/terminal-binding-store.mjs",
  "scripts/terminal-control-capability.mjs",
  "scripts/terminal-relay.mjs",
  "scripts/terminal-spectator-policy.mjs",
  "scripts/theme-7-loader.mjs",
  "scripts/workspace-roots.mjs",
])

export const RUNTIME_FILES = Object.freeze([
  ...CONTAINER_RUNTIME_FILES,
  ".env.example",
  "README.md",
  "SECURITY.md",
  "scripts/bin/operator-engine.cmd",
  "scripts/doctor.mjs",
  "scripts/network-probe.mjs",
  "scripts/setup-secret-policy.mjs",
  "scripts/setup.mjs",
].sort())

function assertRelativeFile(relative) {
  if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid runtime file policy entry: ${relative}`)
  }
}

export function validateRuntimeFilePolicy(sourceRoot, files = RUNTIME_FILES) {
  if (new Set(files).size !== files.length) throw new Error("Runtime file policy contains duplicates.")
  for (const relative of files) {
    assertRelativeFile(relative)
    const source = path.join(sourceRoot, relative)
    if (!fs.existsSync(source)) throw new Error(`Runtime file is missing: ${relative}`)
    const stat = fs.lstatSync(source)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Runtime file must be a regular file: ${relative}`)
  }
  return [...files]
}

export async function materializeRuntimeFiles(sourceRoot, destinationRoot, { clean = true, files = RUNTIME_FILES } = {}) {
  const validated = validateRuntimeFilePolicy(sourceRoot, files)
  if (clean) await fsp.rm(destinationRoot, { recursive: true, force: true })
  for (const relative of validated) {
    const destination = path.join(destinationRoot, relative)
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    await fsp.copyFile(path.join(sourceRoot, relative), destination)
  }
  return validated
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const files = validateRuntimeFilePolicy(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))
  process.stdout.write(`Runtime file surface OK: ${files.length} files.\n`)
}
