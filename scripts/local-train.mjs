#!/usr/bin/env node

// This is a local maintainer workflow for developing Operator Engine
// without destabilizing the copy used for daily work. It is not part of the
// application's product model.

import { spawn, spawnSync, execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import readline from "node:readline/promises"
import { fileURLToPath } from "node:url"

import { createArtifactManifest } from "./artifact-policy.mjs"
import {
  STAGES,
  backupSqlite,
  commandMatches,
  createProfiles,
  defaultTrainRoot,
  ensureTrainDirectories,
  directoryContentSha256,
  fetchStageHealth,
  loadProfiles,
  isSelfTerminatingDailyAction,
  migrateReviewData,
  packageStandalone,
  parseEnvFile,
  rebindRuntimeProfile,
  pidAlive,
  portAvailable,
  processCommandLine,
  readJson,
  safeTimestamp,
  saveProfiles,
  stateRecordMatches,
  waitForStageHealth,
  writeJson,
} from "./local-train-core.mjs"

const require = createRequire(import.meta.url)
const Database = require("better-sqlite3")
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const trainRoot = defaultTrainRoot()
const args = process.argv.slice(2)

const profileFile = (stage) => path.join(trainRoot, "profiles", `${stage}.json`)
const processFile = (stage) => path.join(trainRoot, "state", `${stage}-process.json`)
const candidateFile = () => path.join(trainRoot, "state", "candidate-artifact.json")
const dailyFile = () => path.join(trainRoot, "state", "daily-artifact.json")
const configFile = () => path.join(trainRoot, "state", "train.json")

function die(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function option(name) {
  const prefix = `--${name}=`
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null
}

async function confirm(expected, message) {
  const supplied = option("confirm")
  if (supplied !== null) {
    if (supplied !== expected && supplied !== expected.slice(0, 12)) throw new Error(`Confirmation must equal ${expected}`)
    return
  }
  if (!process.stdin.isTTY) throw new Error(`Interactive confirmation required. Re-run with --confirm=${expected}`)
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await prompt.question(`${message}\nType ${expected} to continue: `)).trim()
    if (answer !== expected) throw new Error("Confirmation did not match; nothing changed.")
  } finally { prompt.close() }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
    encoding: options.encoding,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status ?? "an unknown status"}`)
  return result.stdout
}

function git(commandArgs, options = {}) {
  return run("git", commandArgs, { ...options, encoding: options.encoding ?? "utf8" })
}

function npm(commandArgs, options = {}) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error("Run the local train through `npm run train -- ...`.")
  return run(process.execPath, [npmCli, ...commandArgs], options)
}

async function initializeProfiles() {
  await ensureTrainDirectories(trainRoot)
  const existing = await loadProfiles(trainRoot)
  const environmentFile = path.join(repositoryRoot, ".env.local")
  const sourceEnvironment = parseEnvFile(fs.existsSync(environmentFile) ? fs.readFileSync(environmentFile, "utf8") : "")
  const profiles = createProfiles({ trainRoot, repositoryRoot, sourceEnvironment, existing })
  await saveProfiles(trainRoot, profiles)
  await writeJson(configFile(), {
    schemaVersion: 1,
    repositoryRoot,
    createdAt: (await readJson(configFile()))?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  return { profiles, sourceEnvironment }
}

async function profile(stage) {
  const value = await readJson(profileFile(stage))
  if (!value) throw new Error("Local train is not initialized. Run `npm run train -- init` first.")
  return value
}

async function rotateLog(file) {
  const previous = `${file}.1`
  await fsp.rm(previous, { force: true })
  if (fs.existsSync(file)) await fsp.rename(file, previous)
}

async function stageArtifact(stage) {
  if (stage === "candidate") {
    const pointer = await readJson(candidateFile())
    if (!pointer) throw new Error("No candidate artifact exists. Run `npm run train -- candidate build` first.")
    return pointer
  }
  if (stage === "daily") {
    const pointer = await readJson(dailyFile())
    if (!pointer?.current) throw new Error("No Daily artifact is promoted yet.")
    return pointer.current
  }
  return null
}

async function stageSpecification(stage) {
  const stageProfile = await profile(stage)
  if (stage === "workshop") {
    return {
      profile: stageProfile,
      cwd: repositoryRoot,
      entry: path.join(repositoryRoot, "scripts", "run.mjs"),
      commandArgs: [path.join(repositoryRoot, "scripts", "run.mjs"), "dev"],
      release: null,
    }
  }
  const release = await stageArtifact(stage)
  return {
    profile: stageProfile,
    cwd: release.path,
    entry: path.join(release.path, "scripts", "run.mjs"),
    commandArgs: [path.join(release.path, "scripts", "run.mjs"), "start"],
    release,
  }
}

async function stageHealth(stageProfile) {
  return fetchStageHealth(stageProfile)
}

async function startStage(stage) {
  const specification = await stageSpecification(stage)
  const prior = await readJson(processFile(stage))
  if (prior && pidAlive(prior.pid)) {
    if (!stateRecordMatches({ stage, state: prior, profile: specification.profile, repositoryRoot, trainRoot, specification })) throw new Error(`${stage} ownership record does not match the requested source, artifact, or ports; refusing to replace it.`)
    const command = processCommandLine(prior.pid)
    if (!commandMatches(command, prior.entry)) throw new Error(`${stage} PID ${prior.pid} no longer belongs to its recorded command; refusing to replace it.`)
    const health = await stageHealth(specification.profile)
    if (health.healthy) {
      process.stdout.write(`${stage} is already healthy on ${specification.profile.OPERATOR_ENGINE_PORT}/${specification.profile.OPERATOR_ENGINE_TERMINAL_PORT}.\n`)
      return prior
    }
    throw new Error(`${stage} is running but unhealthy. Inspect its logs, then use an explicit restart.`)
  }
  if (prior) await fsp.rm(processFile(stage), { force: true })

  for (const port of [specification.profile.OPERATOR_ENGINE_PORT, specification.profile.OPERATOR_ENGINE_TERMINAL_PORT]) {
    if (!(await portAvailable(Number(port)))) throw new Error(`Port ${port} is occupied by an unowned process; refusing to start ${stage}.`)
  }

  await Promise.all([
    fsp.mkdir(specification.profile.OPERATOR_ENGINE_DATA_DIR, { recursive: true }),
    fsp.mkdir(specification.profile.OPERATOR_ENGINE_WORKSPACE_ROOT, { recursive: true }),
    fsp.mkdir(path.join(specification.profile.OPERATOR_ENGINE_DATA_DIR, "recipes"), { recursive: true }),
  ])
  const stdout = path.join(trainRoot, "logs", `${stage}.stdout.log`)
  const stderr = path.join(trainRoot, "logs", `${stage}.stderr.log`)
  await rotateLog(stdout)
  await rotateLog(stderr)
  const stdoutFd = fs.openSync(stdout, "a")
  const stderrFd = fs.openSync(stderr, "a")
  const env = {
    ...process.env,
    ...specification.profile,
    ...(specification.release ? { OPERATOR_ENGINE_RELEASE_ID: specification.release.id } : {}),
    NODE_ENV: stage === "workshop" ? "development" : "production",
    NEXT_TELEMETRY_DISABLED: "1",
    OPERATOR_ENGINE_STANDALONE: stage === "workshop" ? "0" : "1",
  }
  const child = spawn(process.execPath, specification.commandArgs, {
    cwd: specification.cwd,
    env,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
  })
  fs.closeSync(stdoutFd)
  fs.closeSync(stderrFd)
  child.unref()
  const state = {
    schemaVersion: 1,
    stage,
    pid: child.pid,
    entry: specification.entry,
    cwd: specification.cwd,
    webPort: Number(specification.profile.OPERATOR_ENGINE_PORT),
    terminalPort: Number(specification.profile.OPERATOR_ENGINE_TERMINAL_PORT),
    releaseId: specification.release?.id ?? null,
    startedAt: new Date().toISOString(),
  }
  await writeJson(processFile(stage), state)
  const healthy = await waitForStageHealth(specification.profile, stage === "workshop" ? 120_000 : 60_000)
  if (!healthy) {
    await stopStage(stage, { quiet: true }).catch(() => undefined)
    throw new Error(`${stage} did not become healthy. Inspect ${stdout} and ${stderr}.`)
  }
  process.stdout.write(`${stage} is healthy at http://127.0.0.1:${specification.profile.OPERATOR_ENGINE_PORT}.\n`)
  return state
}

async function terminateTree(pid) {
  if (!pidAlive(pid)) return
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    if (result.status !== 0 && pidAlive(pid)) throw new Error(`Could not terminate process tree ${pid}`)
  } else {
    try { process.kill(-pid, "SIGTERM") } catch { process.kill(pid, "SIGTERM") }
  }
  const deadline = Date.now() + 10_000
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
  if (pidAlive(pid) && process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL") } catch { process.kill(pid, "SIGKILL") }
  }
}

async function stopStage(stage, { quiet = false } = {}) {
  const stageProfile = await profile(stage)
  const state = await readJson(processFile(stage))
  if (!state) {
    const portsFree = await Promise.all([stageProfile.OPERATOR_ENGINE_PORT, stageProfile.OPERATOR_ENGINE_TERMINAL_PORT].map((port) => portAvailable(Number(port))))
    if (portsFree.every(Boolean)) {
      if (!quiet) process.stdout.write(`${stage} is already stopped.\n`)
      return
    }
    throw new Error(`${stage} has no ownership record but one of its ports is occupied; refusing to stop anything.`)
  }
  if (!stateRecordMatches({ stage, state, profile: stageProfile, repositoryRoot, trainRoot })) throw new Error(`${stage} ownership record does not match its source, artifact boundary, or ports; refusing to stop anything.`)
  if (pidAlive(state.pid)) {
    const command = processCommandLine(state.pid)
    if (!commandMatches(command, state.entry)) throw new Error(`${stage} PID ${state.pid} does not match ${state.entry}; refusing to stop it.`)
    await terminateTree(state.pid)
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const free = await Promise.all([stageProfile.OPERATOR_ENGINE_PORT, stageProfile.OPERATOR_ENGINE_TERMINAL_PORT].map((port) => portAvailable(Number(port))))
    if (free.every(Boolean)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const free = await Promise.all([stageProfile.OPERATOR_ENGINE_PORT, stageProfile.OPERATOR_ENGINE_TERMINAL_PORT].map((port) => portAvailable(Number(port))))
  if (!free.every(Boolean)) throw new Error(`${stage} ports remain occupied after its recorded supervisor stopped.`)
  await fsp.rm(processFile(stage), { force: true })
  if (!quiet) process.stdout.write(`${stage} stopped.\n`)
}

async function printStatus() {
  const profiles = await loadProfiles(trainRoot)
  process.stdout.write(`Operator Engine local train\nRoot: ${trainRoot}\n`)
  if (Object.keys(profiles).length !== Object.keys(STAGES).length) {
    process.stdout.write("Not initialized.\n")
    return
  }
  for (const stage of ["daily", "candidate", "workshop"]) {
    const state = await readJson(processFile(stage))
    const alive = state ? pidAlive(state.pid) : false
    const shaped = state ? stateRecordMatches({ stage, state, profile: profiles[stage], repositoryRoot, trainRoot }) : false
    const owned = alive && shaped ? commandMatches(processCommandLine(state.pid), state.entry) : false
    const health = await stageHealth(profiles[stage])
    const status = health.healthy && owned ? "healthy" : alive ? owned ? "unhealthy" : "ownership mismatch" : health.web || health.relay ? "unowned listener" : "stopped"
    process.stdout.write(`${stage.padEnd(10)} ${profiles[stage].OPERATOR_ENGINE_PORT}/${profiles[stage].OPERATOR_ENGINE_TERMINAL_PORT} ${status}${state?.releaseId ? ` ${state.releaseId}` : ""}\n`)
  }
}
async function findTestPorts(start = 4550) {
  for (let port = start; port < 4650; port += 2) {
    if (await portAvailable(port) && await portAvailable(port + 1)) return [port, port + 1]
  }
  throw new Error("No free browser-smoke port pair was found between 4550 and 4649.")
}

async function buildCandidate() {
  await initializeProfiles()
  const running = await readJson(processFile("candidate"))
  if (running && pidAlive(running.pid)) throw new Error("Stop the running Candidate before building another artifact.")
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true })
  if (status.trim()) throw new Error("Candidate builds require a clean committed worktree.")
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }).trim()
  const distribution = "theme-7"
  const id = `${commit.slice(0, 12)}-theme7-${process.platform}-${process.arch}`
  const releasePath = path.join(trainRoot, "releases", id)
  if (fs.existsSync(releasePath)) throw new Error(`Artifact ${id} already exists; refusing to overwrite it.`)
  const buildRoot = path.join(trainRoot, "build", id)
  if (fs.existsSync(buildRoot)) throw new Error(`Detached build path already exists: ${buildRoot}`)
  git(["worktree", "add", "--detach", buildRoot, commit])
  try {
    const buildEnvironment = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OPERATOR_ENGINE_"))),
      NEXT_TELEMETRY_DISABLED: "1",
      OPERATOR_ENGINE_STANDALONE: "0",
      OPERATOR_ENGINE_DISTRIBUTION: "theme-7",
    }
    npm(["ci"], { cwd: buildRoot, env: buildEnvironment })
    const theme7Source = path.join(buildRoot, ".theme-7-package")
    npm(["run", "validate:local"], { cwd: buildRoot, env: buildEnvironment })
    await fsp.cp(path.join(buildRoot, "node_modules", "theme-7"), theme7Source, { recursive: true, force: false, errorOnExist: true })
    const [webPort, terminalPort] = await findTestPorts()
    npm(["run", "test:browser"], {
      cwd: buildRoot,
      env: {
        ...buildEnvironment,
        OPERATOR_ENGINE_TEST_PORT: String(webPort),
        OPERATOR_ENGINE_TEST_TERMINAL_PORT: String(terminalPort),
        OPERATOR_ENGINE_TEST_DISTRIBUTION: "theme-7",
        OPERATOR_ENGINE_TEST_EXPECTED_DISTRIBUTION: "theme-7",
      },
    })

    npm(["prune", "--omit=dev"], { cwd: buildRoot, env: buildEnvironment })
    const manifest = createArtifactManifest({
      schemaVersion: 1,
      sourceCommit: commit,
      distribution,
      theme7Sha256: await directoryContentSha256(theme7Source),
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      builtAt: new Date().toISOString(),
      contentSha256: "",
      checks: {
        localValidation: true,
        browserBoundary: true,
        productionPrune: true,

      },
    })
    const artifact = await packageStandalone({ buildRoot, destination: releasePath, manifest, theme7Source })
    const pointer = { id, commit, distribution, path: releasePath, builtAt: artifact.builtAt }
    await writeJson(candidateFile(), pointer)
    process.stdout.write(`Candidate artifact ready: ${id}\n`)
  } finally {
    try { git(["worktree", "remove", "--force", buildRoot], { stdio: "ignore" }) } catch { /* leave evidence for manual inspection */ }
    try { git(["worktree", "prune"], { stdio: "ignore" }) } catch { /* non-fatal cleanup */ }
  }
}

async function initialize() {
  const { profiles, sourceEnvironment } = await initializeProfiles()
  process.stdout.write(`Local train profiles initialized under ${trainRoot}. Secrets were not printed.\n`)
  const adopt = args.includes("--adopt-current")
  const sourceData = path.resolve(sourceEnvironment.OPERATOR_ENGINE_DATA_DIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".operator-engine"))
  const sourceDatabase = path.resolve(sourceEnvironment.OPERATOR_ENGINE_DB_PATH ?? path.join(sourceData, "client.sqlite"))
  const sourceWorkspace = path.resolve(sourceEnvironment.OPERATOR_ENGINE_WORKSPACE_ROOT ?? path.join(sourceData, "workspace"))
  const destinationDatabase = profiles.daily.OPERATOR_ENGINE_DB_PATH
  if (fs.existsSync(destinationDatabase)) {
    process.stdout.write(`Daily data already exists at ${profiles.daily.OPERATOR_ENGINE_DATA_DIR}.\n`)
    return
  }
  if (!fs.existsSync(sourceDatabase)) {
    process.stdout.write("No existing review database was found; Daily will initialize fresh when promoted.\n")
    return
  }
  if (!adopt) {
    process.stdout.write("Existing review data is ready to adopt. Stop its runtime, then run `npm run train -- init --adopt-current --confirm=ADOPT`.\n")
    return
  }
  await confirm("ADOPT", `Adopt ${sourceData} into permanent Daily data at ${profiles.daily.OPERATOR_ENGINE_DATA_DIR}? The source will remain untouched.`)
  for (const port of [STAGES.daily.webPort, STAGES.daily.terminalPort]) {
    if (!(await portAvailable(port))) throw new Error(`Port ${port} is still occupied. Stop the existing review runtime before adoption.`)
  }
  const result = await migrateReviewData({
    Database,
    sourceData,
    sourceDatabase,
    sourceWorkspace,
    destinationData: profiles.daily.OPERATOR_ENGINE_DATA_DIR,
  })
  process.stdout.write(`Adopted and verified ${result.laneCount} lanes. The original review root remains untouched.\n`)
}

async function createDailyBackup(label) {
  const daily = await profile("daily")
  if (!fs.existsSync(daily.OPERATOR_ENGINE_DB_PATH)) return null
  const destination = path.join(trainRoot, "backups", `${safeTimestamp()}-${label}.sqlite`)
  await backupSqlite(Database, daily.OPERATOR_ENGINE_DB_PATH, destination)
  return destination
}

async function requireHealthyCandidate(pointer) {
  const processState = await readJson(processFile("candidate"))
  if (!processState || processState.releaseId !== pointer.id || !pidAlive(processState.pid)) throw new Error("The selected candidate artifact is not running under the train supervisor.")
  if (!commandMatches(processCommandLine(processState.pid), processState.entry)) throw new Error("Candidate process ownership no longer matches its record.")
  const health = await stageHealth(await profile("candidate"))
  if (!health.healthy) throw new Error("Candidate web and relay health must both pass before promotion.")
}

async function writeReceipt(kind, value) {
  const file = path.join(trainRoot, "receipts", `${safeTimestamp()}-${kind}.json`)
  await writeJson(file, { schemaVersion: 1, kind, recordedAt: new Date().toISOString(), ...value })
  return file
}

async function promote() {
  const candidate = await readJson(candidateFile())
  if (!candidate) throw new Error("No candidate artifact exists.")
  await requireHealthyCandidate(candidate)
  const prior = await readJson(dailyFile(), { missing: { current: null, previous: null } })
  const daily = await profile("daily")
  const targetDaily = option("port") === null ? daily : rebindRuntimeProfile(daily, option("port"))
  process.stdout.write(`Candidate: ${candidate.id}\nSource: ${candidate.commit}\nDaily database: ${daily.OPERATOR_ENGINE_DB_PATH}\nDestination: http://127.0.0.1:${targetDaily.OPERATOR_ENGINE_PORT}\nFallback: ${prior.current?.id ?? "none"}\n`)
  await confirm(candidate.commit, "Promotion will restart Daily and terminate its active terminal processes. Durable lanes and resumable OMP sessions remain in the same data store.")
  const backup = await createDailyBackup(`pre-promote-${candidate.id}`)
  await stopStage("candidate", { quiet: true })
  await stopStage("daily", { quiet: true })
  const nextPointer = { current: candidate, previous: prior.current ?? prior.previous ?? null, promotedAt: new Date().toISOString() }
  await writeJson(profileFile("daily"), targetDaily, { privateFile: true })
  await writeJson(dailyFile(), nextPointer)
  try {
    await startStage("daily")
    const receipt = await writeReceipt("promotion", { outcome: "passed", candidate, previous: nextPointer.previous, backup, webPort: Number(targetDaily.OPERATOR_ENGINE_PORT), terminalPort: Number(targetDaily.OPERATOR_ENGINE_TERMINAL_PORT) })
    process.stdout.write(`Promoted ${candidate.id}. Open http://127.0.0.1:${targetDaily.OPERATOR_ENGINE_PORT}; durable lanes and resumable OMP sessions are intact. Receipt: ${receipt}\n`)
  } catch (error) {
    await writeJson(profileFile("daily"), daily, { privateFile: true })
    await writeJson(dailyFile(), prior)
    if (prior.current) await startStage("daily").catch(() => undefined)
    await writeReceipt("promotion", { outcome: "failed", candidate, previous: prior.current, backup, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function moveDaily() {
  const pointer = await readJson(dailyFile())
  if (!pointer?.current) throw new Error("Daily does not have a promoted artifact to move.")
  const current = await profile("daily")
  const target = rebindRuntimeProfile(current, option("port"))
  if (target.OPERATOR_ENGINE_PORT === current.OPERATOR_ENGINE_PORT) {
    process.stdout.write(`Daily already runs at http://127.0.0.1:${current.OPERATOR_ENGINE_PORT}.\n`)
    return
  }
  process.stdout.write(`Artifact: ${pointer.current.id}\nDurable database: ${current.OPERATOR_ENGINE_DB_PATH}\nDestination: http://127.0.0.1:${target.OPERATOR_ENGINE_PORT}\n`)
  await confirm(pointer.current.commit, "Moving Daily changes ports and restarts terminal processes. Durable lanes and resumable OMP sessions remain in the same data store.")
  const backup = await createDailyBackup(`pre-move-${target.OPERATOR_ENGINE_PORT}`)
  await stopStage("daily", { quiet: true })
  await writeJson(profileFile("daily"), target, { privateFile: true })
  try {
    await startStage("daily")
    const receipt = await writeReceipt("port-move", { outcome: "passed", artifact: pointer.current, backup, from: Number(current.OPERATOR_ENGINE_PORT), to: Number(target.OPERATOR_ENGINE_PORT) })
    process.stdout.write(`Open http://127.0.0.1:${target.OPERATOR_ENGINE_PORT}; durable lanes and resumable OMP sessions are intact. Receipt: ${receipt}\n`)
  } catch (error) {
    await writeJson(profileFile("daily"), current, { privateFile: true })
    await startStage("daily").catch(() => undefined)
    await writeReceipt("port-move", { outcome: "failed", artifact: pointer.current, backup, from: Number(current.OPERATOR_ENGINE_PORT), to: Number(target.OPERATOR_ENGINE_PORT), error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function rollback() {
  const pointer = await readJson(dailyFile())
  if (!pointer?.current || !pointer?.previous) throw new Error("Daily does not have a previous artifact to roll back to.")
  process.stdout.write(`Current: ${pointer.current.id}\nRollback target: ${pointer.previous.id}\nDatabase remains current: ${(await profile("daily")).OPERATOR_ENGINE_DB_PATH}\n`)
  await confirm(pointer.previous.commit, "Rollback changes code only and restarts Daily; it does not restore an older database.")
  const backup = await createDailyBackup(`pre-rollback-${pointer.previous.id}`)
  await stopStage("daily", { quiet: true })
  const next = { current: pointer.previous, previous: pointer.current, promotedAt: new Date().toISOString() }
  await writeJson(dailyFile(), next)
  try {
    await startStage("daily")
    const receipt = await writeReceipt("rollback", { outcome: "passed", from: pointer.current, to: pointer.previous, backup })
    process.stdout.write(`Rolled back to ${pointer.previous.id}. Receipt: ${receipt}\n`)
  } catch (error) {
    await writeJson(dailyFile(), pointer)
    await startStage("daily").catch(() => undefined)
    await writeReceipt("rollback", { outcome: "failed", from: pointer.current, to: pointer.previous, backup, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function main() {
  const [command, action] = args
  if (isSelfTerminatingDailyAction(command, action)) {
    throw new Error("This action cannot run from a Daily terminal because it would terminate its own command. Run it from Workshop on 4500 or an external shell.")
  }
  if (command === "init") return initialize()
  if (command === "status") return printStatus()
  if (command === "promote") return promote()
  if (command === "rollback") return rollback()
  if (command === "daily" && action === "move") return moveDaily()
  if (!(command in STAGES)) throw new Error("Usage: train <init|status|workshop|candidate|daily|promote|rollback> [build|start|stop|restart|move]")
  if (command === "candidate" && action === "build") return buildCandidate()
  if (action === "start") return startStage(command)
  if (action === "stop") return stopStage(command)
  if (action === "restart") {
    if (command === "daily") process.stdout.write("Restarting Daily terminates active terminal processes.\n")
    await stopStage(command)
    return startStage(command)
  }
  throw new Error(`Usage: train ${command} <${command === "candidate" ? "build|" : ""}start|stop|restart${command === "daily" ? "|move --port=PORT" : ""}>`)
}

try { await main() } catch (error) { die(error instanceof Error ? error.message : String(error)) }
