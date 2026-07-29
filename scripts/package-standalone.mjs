import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createArtifactManifest } from "./artifact-policy.mjs"
import { packageStandalone } from "./local-train-core.mjs"
import { isPathInside } from "./path-policy.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const artifactsRoot = path.join(root, "artifacts")

function parseArguments(argv) {
  const parsed = { output: null, theme7: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== "--output" && flag !== "--theme-7") throw new Error(`Unknown flag: ${flag}`)
    const value = argv[index += 1]
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires an absolute path.`)
    if (!path.isAbsolute(value)) throw new Error(`${flag} requires an absolute path.`)
    const key = flag === "--output" ? "output" : "theme7"
    if (parsed[key]) throw new Error(`${flag} may be supplied only once.`)
    parsed[key] = path.resolve(value)
  }
  return parsed
}

async function realDestination(destination) {
  let ancestor = path.dirname(destination)
  const suffix = []
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor))
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error("Output parent does not exist.")
    ancestor = parent
  }
  const realAncestor = await fsp.realpath(ancestor)
  return path.join(realAncestor, ...suffix, path.basename(destination))
}

function gitWorktrees() {
  const output = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8", windowsHide: true })
  return output.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => path.resolve(line.slice(9)))
}

async function filesUnder(directory) {
  const files = []
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Theme 7 contains a symbolic link: ${path.relative(directory, absolute)}`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  await visit(directory)
  return files.sort((left, right) => path.relative(directory, left).localeCompare(path.relative(directory, right)))
}

async function directorySha256(directory) {
  const identity = createHash("sha256")
  for (const file of await filesUnder(directory)) {
    identity.update(path.relative(directory, file).split(path.sep).join("/")).update("\0")
    identity.update(createHash("sha256").update(await fsp.readFile(file)).digest("hex"))
  }
  return identity.digest("hex")
}

async function validateThemeRoot(candidate) {
  const themeRoot = await fsp.realpath(candidate)
  if (fs.existsSync(path.join(themeRoot, ".git"))) throw new Error("Theme 7 package members must not contain .git.")
  if (fs.existsSync(path.join(themeRoot, "package-lock.json"))) throw new Error("Theme 7 source must not contain package-lock.json.")
  await filesUnder(themeRoot)
  const metadata = JSON.parse(await fsp.readFile(path.join(themeRoot, "package.json"), "utf8"))
  if (metadata.name !== "theme-7" || metadata.private || metadata.license !== "MIT" || !metadata.version || !Array.isArray(metadata.files)) throw new Error("Theme 7 package metadata is invalid.")
  return { root: themeRoot, sha256: await directorySha256(themeRoot), metadata }
}

async function materializeThemeDirectory(sourceRoot, temporaryRoot) {
  if (fs.existsSync(path.join(sourceRoot, "package-lock.json"))) throw new Error("Theme 7 source must not contain package-lock.json.")
  const metadata = JSON.parse(await fsp.readFile(path.join(sourceRoot, "package.json"), "utf8"))
  if (metadata.name !== "theme-7" || metadata.private || metadata.license !== "MIT" || !metadata.version || !Array.isArray(metadata.files)) throw new Error("Theme 7 package metadata is invalid.")
  const reviewedRoot = path.join(temporaryRoot, "reviewed-theme")
  await fsp.mkdir(reviewedRoot, { recursive: true })
  for (const member of ["package.json", ...metadata.files]) {
    if (path.isAbsolute(member) || member.split(/[\\/]/).includes("..") || member === ".git") throw new Error("Theme 7 package members are invalid.")
    const source = path.join(sourceRoot, member)
    const status = await fsp.lstat(source)
    if (status.isSymbolicLink()) throw new Error(`Theme 7 contains a symbolic link: ${member}`)
    await fsp.cp(source, path.join(reviewedRoot, member), { recursive: true, force: false, errorOnExist: true })
  }
  return { ...(await validateThemeRoot(reviewedRoot)), sourceRoot }
}

async function resolveThemeSource(source, temporaryRoot) {
  const realSource = await fsp.realpath(source)
  if ((await fsp.stat(realSource)).isDirectory()) return materializeThemeDirectory(realSource, temporaryRoot)
  if (!realSource.endsWith(".tgz")) throw new Error("Theme 7 source must be a package root or .tgz archive.")
  const names = execFileSync("tar", ["-tzf", realSource], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean)
  if (!names.length || names.some((name) => path.isAbsolute(name) || name.split(/[\\/]/).includes("..") || name === ".git" || name.includes("/.git/") || name.endsWith("/package-lock.json"))) throw new Error("Theme 7 archive members are invalid.")
  const verbose = execFileSync("tar", ["-tvzf", realSource], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean)
  if (verbose.some((line) => /^[lh]/.test(line))) throw new Error("Theme 7 archive must not contain symbolic or hard links.")
  const extracted = path.join(temporaryRoot, "theme")
  await fsp.mkdir(extracted, { recursive: true })
  execFileSync("tar", ["-xzf", realSource, "-C", extracted], { windowsHide: true })
  const entries = await fsp.readdir(extracted)
  const packageRoot = entries.length === 1 && fs.statSync(path.join(extracted, entries[0])).isDirectory() ? path.join(extracted, entries[0]) : extracted
  const validated = await validateThemeRoot(packageRoot)
  return { ...validated, sha256: createHash("sha256").update(await fsp.readFile(realSource)).digest("hex") }
}

function npmCommand() {
  return process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm"
}

function runBuild(environment) {
  const command = npmCommand()
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm run build"] : ["run", "build"]
  execFileSync(command, args, { cwd: root, env: environment, stdio: "inherit", windowsHide: true })
}

const options = parseArguments(process.argv.slice(2))
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "operator-engine-package-"))
const distName = `.next-package-${randomUUID()}`
const tsconfigPath = path.join(root, "tsconfig.json")
const tsconfigBefore = await fsp.readFile(tsconfigPath)
process.env.OPERATOR_ENGINE_PACKAGE_NEXT_DIST_DIR = distName
try {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim()
  const suffix = options.theme7 ? "theme-7" : "stock"
  const requestedOutput = options.output ?? path.join(artifactsRoot, `operator-engine-${commit.slice(0, 12)}-${suffix}`)
  const destination = await realDestination(requestedOutput)
  const worktrees = gitWorktrees()
  const underArtifacts = isPathInside(await fsp.realpath(fs.existsSync(artifactsRoot) ? artifactsRoot : root), destination) && isPathInside(artifactsRoot, destination)
  if (!underArtifacts && worktrees.some((worktree) => isPathInside(worktree, destination))) throw new Error("Output must be under artifacts or outside every Git worktree.")
  if (isPathInside(root, destination) && !isPathInside(artifactsRoot, destination)) throw new Error("Output inside the application source is not allowed.")
  if (fs.existsSync(destination)) throw new Error(`Artifact already exists: ${destination}`)
  const theme = options.theme7 ? await resolveThemeSource(options.theme7, temporaryRoot) : null
  if (theme && isPathInside(theme.sourceRoot ?? theme.root, destination)) throw new Error("Output inside the Theme 7 source is not allowed.")

  runBuild({ ...process.env, NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1", OPERATOR_ENGINE_BUILD_ID: commit, OPERATOR_ENGINE_PACKAGE_NEXT_DIST_DIR: distName, OPERATOR_ENGINE_NEXT_DIST_DIR: distName })
  const manifest = createArtifactManifest({
    schemaVersion: 1,
    sourceCommit: commit,
    distribution: theme ? "theme-7" : "stock",
    theme7Sha256: theme?.sha256 ?? null,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    builtAt: new Date().toISOString(),
    contentSha256: "",
    checks: { freshBuild: true, themeValidated: Boolean(theme) },
  })
  const artifact = await packageStandalone({ buildRoot: root, destination, manifest, theme7Source: theme?.root })
  process.stdout.write(`${destination}\ncontentSha256:${artifact.contentSha256}\n`)
} finally {
  await fsp.rm(path.join(root, distName), { recursive: true, force: true })
  await fsp.writeFile(tsconfigPath, tsconfigBefore)
  delete process.env.OPERATOR_ENGINE_PACKAGE_NEXT_DIST_DIR
  await fsp.rm(temporaryRoot, { recursive: true, force: true })
}
