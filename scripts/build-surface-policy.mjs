import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { expandDeclaredPackageFiles } from "./source-package-policy.mjs"
import { CONTAINER_RUNTIME_FILES } from "./runtime-files-policy.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export const DOCKER_ROOT_FILES = Object.freeze([
  ".dockerignore",
  "Dockerfile",
  "LICENSE",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "postcss.config.mjs",
  "proxy.ts",
  "tsconfig.json",
])

export const DOCKER_SOURCE_DIRECTORIES = Object.freeze([
  "app",
  "components",
  "editions",
  "lib",
  "recipes",
])

export const DOCKER_SCRIPT_FILES = Object.freeze([...new Set([
  ...CONTAINER_RUNTIME_FILES.filter((relative) => relative.startsWith("scripts/")),
  "scripts/harness-adapters.d.mts",
  "scripts/layout-tree-policy.d.mts",
  "scripts/materialize-runtime-files.mjs",
  "scripts/path-policy.d.mts",
  "scripts/prepare-standalone.mjs",
  "scripts/runtime-config-core.d.mts",
  "scripts/runtime-files-policy.mjs",
  "scripts/runtime-identity-policy.d.mts",
  "scripts/terminal-binding-store.d.mts",
  "scripts/terminal-control-capability.d.mts",
])].sort())

export const DOCKER_VENDOR_FILES = Object.freeze([
  "vendor/theme-7-0.1.0.tgz",
  "vendor/operator-studio-thread-ingest-adapter-omp-0.1.0.tgz",
  "vendor/operator-studio-thread-ingest-core-0.1.0.tgz",
])

const dockerExclusions = Object.freeze([
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/.env*",
  "**/*.sqlite",
  "**/*.sqlite-*",
  "**/*.sqlite3",
  "**/*.sqlite3-*",
  "**/*.db",
  "**/*.db-*",
  "**/client-workspace/**",
  "**/.operator-engine/**",
  "**/artifacts/**",
  "**/.review-*/**",
])

export function expectedDockerIgnore() {
  return [
    "**",
    ...DOCKER_ROOT_FILES.map((relative) => `!${relative}`),
    ...DOCKER_SOURCE_DIRECTORIES.flatMap((relative) => [`!${relative}/`, `!${relative}/**`]),
    "!scripts/",
    ...DOCKER_SCRIPT_FILES.map((relative) => `!${relative}`),
    "!vendor/",
    ...DOCKER_VENDOR_FILES.map((relative) => `!${relative}`),
    ...dockerExclusions,
    "",
  ].join("\n")
}

function normalized(relative) {
  return relative.replaceAll("\\", "/")
}

export function isDockerContextExcluded(relative) {
  const value = normalized(relative)
  const base = path.posix.basename(value)
  return /(?:^|\/)(?:client-workspace|\.operator-engine|artifacts|\.review-[^/]+)(?:\/|$)/.test(value)
    || /(?:^|\/)__tests__(?:\/|$)/.test(value)
    || /\.(?:test|spec)\.[^.\/]+$/.test(value)
    || (base.startsWith(".env") && value !== ".env.example")
    || /(?:\.sqlite3?|\.db)(?:-(?:wal|shm))?$/.test(base)
}

function walkRegularFiles(repositoryRoot, relative) {
  const directory = path.join(repositoryRoot, relative)
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = normalized(path.posix.join(relative, entry.name))
    if (isDockerContextExcluded(child)) continue
    if (entry.isSymbolicLink()) throw new Error(`Docker context input is a symlink: ${child}`)
    if (entry.isDirectory()) files.push(...walkRegularFiles(repositoryRoot, child))
    else if (entry.isFile()) files.push(child)
    else throw new Error(`Docker context input is not a regular file: ${child}`)
  }
  return files
}

function assertRegularFiles(repositoryRoot, files, label) {
  for (const relative of files) {
    const absolute = path.join(repositoryRoot, relative)
    if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${relative}`)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${relative}`)
  }
}

export function dockerContextFiles(repositoryRoot) {
  assertRegularFiles(repositoryRoot, [...DOCKER_ROOT_FILES, ...DOCKER_SCRIPT_FILES, ...DOCKER_VENDOR_FILES], "Docker context input")
  const files = new Set([...DOCKER_ROOT_FILES, ...DOCKER_SCRIPT_FILES, ...DOCKER_VENDOR_FILES])
  for (const directory of DOCKER_SOURCE_DIRECTORIES) {
    const absolute = path.join(repositoryRoot, directory)
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw new Error(`Docker source directory is missing: ${directory}`)
    for (const relative of walkRegularFiles(repositoryRoot, directory)) files.add(relative)
  }
  return [...files].sort()
}

export function validateDockerfile(source) {
  if (/^\s*#\s*syntax=/mi.test(source)) throw new Error("Dockerfile must not depend on a mutable external frontend.")
  const stages = new Set()
  let externalBases = 0
  for (const line of source.split(/\r?\n/)) {
    if (!/^\s*FROM\b/i.test(line)) continue
    const match = line.trim().match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i)
    if (!match) throw new Error(`Unsupported Dockerfile FROM instruction: ${line.trim()}`)
    const image = match[1]
    if (!stages.has(image.toLowerCase())) {
      externalBases += 1
      if (!/@sha256:[a-f0-9]{64}$/i.test(image)) throw new Error(`Docker base is not pinned by digest: ${image}`)
    }
    if (match[2]) stages.add(match[2].toLowerCase())
  }
  if (externalBases === 0) throw new Error("Dockerfile has no external base image.")
  if ((source.match(/\bNEXT_TELEMETRY_DISABLED=1\b/g) ?? []).length < 2) throw new Error("Next.js telemetry must be disabled in build and runtime stages.")
  for (const [name, packageReference] of [["BUN_VERSION", "bun"], ["OMP_VERSION", "@oh-my-pi/pi-coding-agent"], ["CODEX_VERSION", "@openai/codex"]]) {
    if (!new RegExp(`^ARG ${name}=\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?$`, "m").test(source)) throw new Error(`${name} must have an exact version.`)
    if (!source.includes(`"${packageReference}@\${${name}}"`)) throw new Error(`${packageReference} must install from ${name}.`)
  }
  return { externalBases }
}

function git(repositoryRoot, args, options = {}) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true, ...options })
  if (result.error) throw result.error
  return result
}

function trackedFiles(repositoryRoot) {
  const result = git(repositoryRoot, ["ls-files", "-z", "--cached"])
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Could not enumerate tracked files.")
  return new Set(result.stdout.split("\0").filter(Boolean).map(normalized))
}

function ignoredFiles(repositoryRoot, files) {
  if (!files.length) return []
  const result = git(repositoryRoot, ["check-ignore", "--no-index", "--stdin"], { input: `${files.join("\n")}\n` })
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr.trim() || "Could not evaluate Git ignore policy.")
  return result.stdout.split(/\r?\n/).filter(Boolean).map(normalized)
}

const requiredIgnoredExamples = Object.freeze([
  ".operator-engine/state.json",
  "artifacts/review.json",
  "nested/client-workspace/session.json",
  ".env.local",
  "nested/.env.production",
  "local.sqlite",
  "local.sqlite-wal",
  "local.db-shm",
  ".next/cache/result",
  ".runtime-surface/scripts/run.mjs",
  "test-results/result.json",
  "review-manifest-local.json",
  "scripts/launcher/bin/launcher.exe",
])

export function validateSourceBuildEntrypoints(metadata, prepareSource, runSource) {
  if (metadata.scripts?.build !== "node scripts/prepare-standalone.mjs --build") throw new Error("Production build must use the reviewed cross-platform wrapper.")
  if (!prepareSource.includes('NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1"')) throw new Error("Production builds must disable Next.js telemetry by default.")
  if (!runSource.includes('process.env.NEXT_TELEMETRY_DISABLED ??= "1"')) throw new Error("Source runtimes must disable Next.js telemetry by default.")
}

export function validateBuildSurfaces(repositoryRoot = root) {
  const dockerIgnore = fs.readFileSync(path.join(repositoryRoot, ".dockerignore"), "utf8").replaceAll("\r\n", "\n")
  if (dockerIgnore !== expectedDockerIgnore()) throw new Error(".dockerignore differs from the deny-by-default build input policy.")
  validateDockerfile(fs.readFileSync(path.join(repositoryRoot, "Dockerfile"), "utf8"))

  const metadata = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
  validateSourceBuildEntrypoints(
    metadata,
    fs.readFileSync(path.join(repositoryRoot, "scripts", "prepare-standalone.mjs"), "utf8"),
    fs.readFileSync(path.join(repositoryRoot, "scripts", "run.mjs"), "utf8"),
  )
  const packageFiles = expandDeclaredPackageFiles(repositoryRoot, metadata.files)
  const dockerFiles = dockerContextFiles(repositoryRoot)
  const tracked = trackedFiles(repositoryRoot)
  const untrackedPackage = packageFiles.filter((relative) => !tracked.has(relative))
  const untrackedDocker = dockerFiles.filter((relative) => !tracked.has(relative))
  const ignoredPackage = ignoredFiles(repositoryRoot, packageFiles)
  const ignoredDocker = ignoredFiles(repositoryRoot, dockerFiles)
  const requiredIgnored = new Set(ignoredFiles(repositoryRoot, requiredIgnoredExamples))
  const missingIgnoreRules = requiredIgnoredExamples.filter((relative) => !requiredIgnored.has(relative))
  const incorrectlyIgnoredExamples = ignoredFiles(repositoryRoot, [".env.example", "nested/.env.example"])

  if (untrackedPackage.length || untrackedDocker.length || ignoredPackage.length || ignoredDocker.length || missingIgnoreRules.length || incorrectlyIgnoredExamples.length) {
    throw new Error([
      "Build surfaces differ from Git ownership and ignore policy.",
      untrackedPackage.length ? `Untracked package inputs: ${untrackedPackage.join(", ")}` : "",
      untrackedDocker.length ? `Untracked Docker inputs: ${untrackedDocker.join(", ")}` : "",
      ignoredPackage.length ? `Ignored package inputs: ${ignoredPackage.join(", ")}` : "",
      ignoredDocker.length ? `Ignored Docker inputs: ${ignoredDocker.join(", ")}` : "",
      missingIgnoreRules.length ? `Required ignore rules missing: ${missingIgnoreRules.join(", ")}` : "",
      incorrectlyIgnoredExamples.length ? `Example environment files are ignored: ${incorrectlyIgnoredExamples.join(", ")}` : "",
    ].filter(Boolean).join("\n"))
  }

  return { packageFiles: packageFiles.length, dockerFiles: dockerFiles.length }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = validateBuildSurfaces()
  process.stdout.write(`Build surfaces OK: ${result.packageFiles} package files; ${result.dockerFiles} Docker inputs.\n`)
}
