import { createHash, randomBytes, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { validateArtifactManifest } from "./artifact-policy.mjs"
import { fetchOk, portAvailable } from "./network-probe.mjs"
import { isPathInside } from "./path-policy.mjs"
import { parseEnvFile, readJson, writeJson } from "./state-io.mjs"
import { materializeRuntimeFiles, RUNTIME_FILES } from "./runtime-files-policy.mjs"

export { parseEnvFile, portAvailable, readJson, writeJson }

export const STAGES = Object.freeze({
  daily: { webPort: 4600, terminalPort: 4601 },
  candidate: { webPort: 4450, terminalPort: 4451 },
  workshop: { webPort: 4500, terminalPort: 4501 },
})

export function isSelfTerminatingDailyAction(command, action, environment = process.env) {
  const webPort = Number(environment.OPERATOR_ENGINE_PORT)
  const terminalPort = Number(environment.OPERATOR_ENGINE_TERMINAL_PORT)
  const isDaily = (environment.OPERATOR_ENGINE_RUNTIME_ROLE === "promoted" && environment.OPERATOR_ENGINE_DATA_CLASS === "durable")
    || (webPort === STAGES.daily.webPort && terminalPort === STAGES.daily.terminalPort)
  if (!isDaily) return false
  return command === "promote"
    || command === "rollback"
    || (command === "daily" && (action === "stop" || action === "restart" || action === "move"))
}

export function defaultTrainRoot() {
  return path.resolve(process.env.OPERATOR_ENGINE_TRAIN_ROOT ?? path.join(os.homedir(), ".operator-engine", "dev-train"))
}


export function uniquePaths(values) {
  const result = new Map()
  for (const value of values.filter(Boolean).map((value) => path.resolve(value))) {
    const key = process.platform === "win32" ? value.toLowerCase() : value
    if (!result.has(key)) result.set(key, value)
  }
  return [...result.values()]
}


export function createProfiles({ trainRoot, repositoryRoot, sourceEnvironment = {}, existing = {} }) {
  const dailyData = path.join(trainRoot, "daily")
  const sourcePrimary = sourceEnvironment.OPERATOR_ENGINE_WORKSPACE_ROOT
  const configured = (sourceEnvironment.OPERATOR_ENGINE_WORKSPACE_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
  const shared = uniquePaths([repositoryRoot, ...configured.filter((value) => !sourcePrimary || path.resolve(value) !== path.resolve(sourcePrimary))])

  const prewarmEnabled = sourceEnvironment.OPERATOR_ENGINE_OMP_PREWARM
  const prewarmTtl = sourceEnvironment.OPERATOR_ENGINE_OMP_PREWARM_TTL_MS
  const prewarm = prewarmEnabled === "1"
    ? {
        OPERATOR_ENGINE_OMP_PREWARM: "1",
        ...(prewarmTtl ? { OPERATOR_ENGINE_OMP_PREWARM_TTL_MS: prewarmTtl }
          : {}),
      }
    : {}

  const make = (stage, data, primary, extras) => ({
    OPERATOR_ENGINE_HOST: "127.0.0.1",
    OPERATOR_ENGINE_PORT: String(STAGES[stage].webPort),
    OPERATOR_ENGINE_TERMINAL_PORT: String(STAGES[stage].terminalPort),
    OPERATOR_ENGINE_DATA_DIR: data,
    OPERATOR_ENGINE_NEXT_DIST_DIR: stage === "workshop" ? ".next-workshop" : ".next",
    OPERATOR_ENGINE_DB_PATH: path.join(data, "theme7.sqlite"),
    OPERATOR_ENGINE_WORKSPACE_ROOT: primary,
    OPERATOR_ENGINE_WORKSPACE_ROOTS: uniquePaths(extras).join(path.delimiter),
    OPERATOR_ENGINE_STANDALONE: stage === "workshop" ? "0" : "1",
    OPERATOR_ENGINE_RUNTIME_ROLE: stage === "daily" ? "promoted" : stage === "candidate" ? "candidate" : "development",
    OPERATOR_ENGINE_RUNTIME_MODE: stage === "workshop" ? "hmr" : "standalone",
    OPERATOR_ENGINE_DATA_CLASS: stage === "daily" ? "durable" : "isolated",
    OPERATOR_ENGINE_TERMINAL_SECRET: existing[stage]?.OPERATOR_ENGINE_TERMINAL_SECRET ?? randomBytes(32).toString("base64url"),
    ...prewarm,
  })

  return {
    daily: make("daily", dailyData, path.join(dailyData, "workspace"), shared),
    candidate: make("candidate", path.join(trainRoot, "candidate"), path.join(trainRoot, "candidate", "workspace"), [path.join(dailyData, "workspace"), ...shared]),
    workshop: make("workshop", path.join(trainRoot, "workshop"), path.join(trainRoot, "workshop", "workspace"), [path.join(dailyData, "workspace"), ...shared]),
  }
}
export function rebindRuntimeProfile(profile, webPort) {
  const parsed = Number(webPort)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_534) throw new Error("Cutover port must be an integer from 1 through 65534.")
  return {
    ...profile,
    OPERATOR_ENGINE_PORT: String(parsed),
    OPERATOR_ENGINE_TERMINAL_PORT: String(parsed + 1),
  }
}



export async function ensureTrainDirectories(trainRoot) {
  await Promise.all(["profiles", "state", "logs", "releases", "build", "backups", "receipts"].map((name) => fsp.mkdir(path.join(trainRoot, name), { recursive: true })))
}

export async function saveProfiles(trainRoot, profiles) {
  await ensureTrainDirectories(trainRoot)
  for (const [stage, profile] of Object.entries(profiles)) {
    await writeJson(path.join(trainRoot, "profiles", `${stage}.json`), profile, { privateFile: true })
  }
}

export async function loadProfiles(trainRoot) {
  const profiles = {}
  for (const stage of Object.keys(STAGES)) {
    const profile = await readJson(path.join(trainRoot, "profiles", `${stage}.json`))
    if (profile) profiles[stage] = profile
  }
  return profiles
}


export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function processCommandLine(pid) {
  if (!pidAlive(pid)) return ""
  try {
    if (process.platform === "win32") {
      const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\").CommandLine`
      return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim()
    }
    if (process.platform === "linux" && fs.existsSync(`/proc/${pid}/cmdline`)) return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim()
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim()
  } catch { return "" }
}

export function commandMatches(commandLine, expectedEntry) {
  const normalize = (value) => {
    const normalized = String(value ?? "").replaceAll("\\", "/")
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
  }
  return Boolean(commandLine) && normalize(commandLine).includes(normalize(path.resolve(expectedEntry)))
}

export function stateRecordMatches({ stage, state, profile, repositoryRoot, trainRoot, specification = null }) {
  if (!state || state.stage !== stage) return false
  if (state.webPort !== Number(profile.OPERATOR_ENGINE_PORT) || state.terminalPort !== Number(profile.OPERATOR_ENGINE_TERMINAL_PORT)) return false
  if (path.resolve(state.entry) !== path.join(path.resolve(state.cwd), "scripts", "run.mjs")) return false
  if (stage === "workshop" && path.resolve(state.cwd) !== path.resolve(repositoryRoot)) return false
  if (stage !== "workshop" && !isPathInside(path.join(trainRoot, "releases"), state.cwd)) return false
  if (specification) {
    if (path.resolve(state.entry) !== path.resolve(specification.entry) || path.resolve(state.cwd) !== path.resolve(specification.cwd)) return false
    if ((state.releaseId ?? null) !== (specification.release?.id ?? null)) return false
  }
  return true
}

export const fetchHealthy = fetchOk

export async function fetchStageHealth(profile) {
  const base = `http://127.0.0.1:${profile.OPERATOR_ENGINE_PORT}`
  const [web, app, relay] = await Promise.all([
    fetchHealthy(`${base}/api/health`),
    fetchHealthy(base, 5_000),
    fetchHealthy(`http://127.0.0.1:${profile.OPERATOR_ENGINE_TERMINAL_PORT}/healthz`),
  ])
  return { web, app, relay, healthy: web && app && relay }
}

export async function waitForStageHealth(profile, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await fetchStageHealth(profile)).healthy) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

export async function backupSqlite(Database, source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const database = new Database(source, { readonly: true, fileMustExist: true })
  try { await database.backup(destination) } finally { database.close() }
  return destination
}

async function copyDurableEntries(sourceRoot, destinationRoot) {
  const excluded = new Set(["client.sqlite", "client.sqlite-shm", "client.sqlite-wal", "theme7.sqlite", "operator-engine.sqlite-shm", "operator-engine.sqlite-wal", "backups"])
  for (const entry of await fsp.readdir(sourceRoot, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name.endsWith(".log")) continue
    await fsp.cp(path.join(sourceRoot, entry.name), path.join(destinationRoot, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    })
  }
}

async function emptyDirectoryTree(directory) {
  if (!fs.existsSync(directory)) return true
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !(await emptyDirectoryTree(path.join(directory, entry.name)))) return false
  }
  return true
}

export async function migrateReviewData({ Database, sourceData, sourceDatabase, sourceWorkspace, destinationData }) {
  const destinationDatabase = path.join(destinationData, "theme7.sqlite")
  if (fs.existsSync(destinationDatabase)) throw new Error(`Daily database already exists at ${destinationDatabase}`)
  if (!(await emptyDirectoryTree(destinationData))) throw new Error(`Daily destination already contains data: ${destinationData}`)
  if (!fs.existsSync(sourceDatabase)) throw new Error(`Source database does not exist: ${sourceDatabase}`)
  if (!fs.existsSync(sourceWorkspace)) throw new Error(`Source workspace does not exist: ${sourceWorkspace}`)

  const staging = `${destinationData}.migrating-${randomUUID()}`
  const destinationWorkspace = path.join(staging, "workspace")
  await fsp.mkdir(staging, { recursive: true })
  try {
    await copyDurableEntries(sourceData, staging)
    await backupSqlite(Database, sourceDatabase, path.join(staging, "theme7.sqlite"))

    const source = new Database(sourceDatabase, { readonly: true, fileMustExist: true })
    const migrated = new Database(path.join(staging, "theme7.sqlite"))
    let laneCount = 0
    try {
      const sourceRows = source.prepare("SELECT * FROM lanes ORDER BY id").all()
      const rows = migrated.prepare("SELECT id, path FROM lanes ORDER BY id").all()
      laneCount = rows.length
      if (sourceRows.length !== rows.length) throw new Error("Lane count changed during migration")
      const update = migrated.prepare("UPDATE lanes SET path = ? WHERE id = ?")
      const rewrite = migrated.transaction(() => {
        for (const row of rows) {
          if (!isPathInside(sourceWorkspace, row.path)) continue
          const relative = path.relative(sourceWorkspace, row.path)
          const stagedPath = path.join(destinationWorkspace, relative)
          const finalPath = path.join(destinationData, "workspace", relative)
          if (!fs.existsSync(stagedPath)) throw new Error(`Migrated lane directory is missing: ${stagedPath}`)
          update.run(finalPath, row.id)
        }
      })
      rewrite()
      const verified = migrated.prepare("SELECT id, path FROM lanes ORDER BY id").all()
      for (const row of verified) {
        if (isPathInside(destinationData, row.path)) {
          const stagedPath = path.join(staging, path.relative(destinationData, row.path))
          if (!fs.existsSync(stagedPath)) throw new Error(`Lane directory is missing after migration: ${row.path}`)
        } else if (!fs.existsSync(row.path)) throw new Error(`External lane directory is missing after migration: ${row.path}`)
      }
    } finally {
      source.close()
      migrated.close()
    }
    await fsp.mkdir(path.dirname(destinationData), { recursive: true })
    if (fs.existsSync(destinationData)) await fsp.rm(destinationData, { recursive: true })
    await fsp.rename(staging, destinationData)
    return { laneCount, destinationDatabase, destinationWorkspace: path.join(destinationData, "workspace") }
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function copyRuntimePackage(buildRoot, staging, packageName, required = true) {
  const source = path.join(buildRoot, "node_modules", ...packageName.split("/"))
  if (!fs.existsSync(source)) {
    if (required) throw new Error(`Runtime dependency is missing: ${packageName}`)
    return
  }
  await fsp.cp(source, path.join(staging, "node_modules", ...packageName.split("/")), { recursive: true, force: true })
}

export async function directoryContentSha256(root) {
  const files = []
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Packaged artifact contains a symbolic link: ${path.relative(root, absolute)}`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && path.relative(root, absolute) !== "artifact.json") files.push(absolute)
    }
  }
  await visit(root)
  const identity = createHash("sha256")
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/")
    const digest = createHash("sha256").update(await fsp.readFile(file)).digest("hex")
    identity.update(relative).update("\0").update(digest)
  }
  return identity.digest("hex")
}
async function scrubBuildRoot(packageRoot, buildRoot, distName) {
  const native = path.resolve(buildRoot)
  const forward = native.split(path.sep).join("/")
  const backward = native.split(path.sep).join("\\")
  const replacements = [
    [backward.replaceAll("\\", "\\\\"), "C:\\\\operator-engine-source"],
    [backward, "C:\\operator-engine-source"],
    [forward, "/operator-engine-source"],
    [encodeURI(forward), "/operator-engine-source"],
    [distName, ".next"],
  ].filter(([value]) => value)
  const textExtensions = new Set([".js", ".json", ".map", ".html", ".txt"])
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
        const source = await fsp.readFile(absolute, "utf8")
        let scrubbed = source
        for (const [value, replacement] of replacements) scrubbed = scrubbed.split(value).join(replacement)
        if (scrubbed !== source) await fsp.writeFile(absolute, scrubbed)
      }
    }
  }
  await visit(packageRoot)
}


export async function packageStandalone({ buildRoot, destination, manifest, theme7Source }) {
  const distName = process.env.OPERATOR_ENGINE_PACKAGE_NEXT_DIST_DIR ?? ".next"
  const distRoot = path.resolve(buildRoot, distName)
  const standalone = path.join(distRoot, "standalone")
  if (!fs.existsSync(path.join(standalone, "server.js"))) throw new Error("Standalone server.js is missing")
  if (fs.existsSync(destination)) throw new Error(`Artifact already exists: ${destination}`)
  const staging = `${destination}.packaging-${randomUUID()}`
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fsp.cp(standalone, staging, { recursive: true, force: false, errorOnExist: true })
    if (distName !== ".next") await fsp.rename(path.join(staging, distName), path.join(staging, ".next"))
    await fsp.rm(path.join(staging, "node_modules", "theme-7"), { recursive: true, force: true })
    for (const packageName of ["better-sqlite3", "ws", "@lydell/node-pty", `@lydell/node-pty-${process.platform}-${process.arch}`]) {
      await copyRuntimePackage(buildRoot, staging, packageName)
    }
    if (theme7Source) await fsp.cp(theme7Source, path.join(staging, "node_modules", "theme-7"), { recursive: true, force: false, errorOnExist: true })
    for (const directory of ["recipes", "editions"]) {
      await fsp.cp(path.join(buildRoot, directory), path.join(staging, directory), { recursive: true, force: true })
    }
    await materializeRuntimeFiles(buildRoot, staging, { clean: false })
    if (fs.existsSync(path.join(buildRoot, "public"))) await fsp.cp(path.join(buildRoot, "public"), path.join(staging, "public"), { recursive: true, force: true })
    if (fs.existsSync(path.join(distRoot, "static"))) await fsp.cp(path.join(distRoot, "static"), path.join(staging, ".next", "static"), { recursive: true, force: true })
    for (const required of ["server.js", ...RUNTIME_FILES, "node_modules/ws/package.json", "node_modules/better-sqlite3/package.json", "node_modules/@lydell/node-pty/package.json", `node_modules/@lydell/node-pty-${process.platform}-${process.arch}/package.json`, ...(theme7Source ? ["node_modules/theme-7/package.json"] : [])]) {
      if (!fs.existsSync(path.join(staging, required))) throw new Error(`Packaged artifact is missing ${required}`)
    }
    await scrubBuildRoot(staging, buildRoot, distName)
    const artifact = validateArtifactManifest({ ...manifest, contentSha256: await directoryContentSha256(staging) }, { packaged: true })
    await writeJson(path.join(staging, "artifact.json"), artifact)
    await fsp.rename(staging, destination)
    return artifact
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true })
    throw error
  }
}

export function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-")
}
