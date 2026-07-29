import { execFileSync } from "node:child_process"
import { rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { isRuntimeIdentity } from "./runtime-identity-policy.mjs"
import { evaluateRuntimeTarget, evaluateRuntimeTargetState, normalizeRuntimeTarget } from "./runtime-target-policy.mjs"
import { readJson, writeJson } from "./state-io.mjs"

const DEFAULT_STATE_PATH = path.join(process.cwd(), ".operator-engine", "runtime-target.json")
const defaultRepositoryCommit = async () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8", windowsHide: true }).trim()

async function readState(statePath) { return readJson(statePath) }
async function writeState(statePath, state) { await writeJson(statePath, state) }

function requireBinding(state) {
  if (!state) throw new Error("No runtime target is bound. Run npm run runtime:target -- bind <url> first.")
  return state
}

function effectivePort(target) {
  const url = new URL(target)
  return Number(url.port || (url.protocol === "https:" ? 443 : 80))
}

async function verifyCapabilities(target, fetchImpl, expectedCommit) {
  let response
  try {
    response = await fetchImpl(`${target}/api/runtime-capabilities`, { signal: AbortSignal.timeout(5_000) })
  } catch (error) {
    throw new Error(`Runtime capability verification failed for ${target}: ${error.message}`)
  }
  if (!response.ok) throw new Error(`Runtime capability verification failed for ${target}: HTTP ${response.status}.`)
  let payload
  try { payload = await response.json() } catch { throw new Error(`Runtime capability verification failed for ${target}: response was not valid JSON.`) }
  const identity = payload?.runtimeIdentity
  if (!isRuntimeIdentity(identity)) throw new Error(`Runtime capability verification failed for ${target}: runtimeIdentity is missing or invalid.`)
  const expectedPort = effectivePort(target)
  if (identity.webPort !== expectedPort) throw new Error(`Runtime capability verification failed for ${target}: runtimeIdentity.webPort ${identity.webPort} does not match target port ${expectedPort}.`)
  if (identity.sourceCommit === null) throw new Error(`Runtime build identity is unavailable at ${target}.`)
  if (identity.sourceCommit.toLowerCase() !== expectedCommit.toLowerCase()) throw new Error(`Runtime build mismatch: repository ${expectedCommit}, target reports ${identity.sourceCommit}.`)
}

export async function runRuntimeTargetCli({
  args = process.argv.slice(2),
  statePath = DEFAULT_STATE_PATH,
  fetchImpl = globalThis.fetch,
  repositoryCommit = defaultRepositoryCommit,
  stdout = (message) => process.stdout.write(`${message}\n`),
  stderr = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  try {
    const [command, first, second] = args
    if (command === "bind") {
      const target = normalizeRuntimeTarget(first)
      const existing = await readState(statePath)
      if (existing) throw new Error(`A runtime target is already bound to ${existing.reportedTarget}. Verify and clear it before binding another target.`)
      await writeState(statePath, { schemaVersion: 1, reportedTarget: target, status: "bound", verifiedTarget: null })
      stdout(`Runtime target ${target} is bound.`)
      return 0
    }
    if (command === "assert") {
      const state = requireBinding(await readState(statePath))
      const errors = evaluateRuntimeTarget({ reportedTarget: state.reportedTarget, attemptedTarget: second, phase: first })
      if (errors.length) throw new Error(errors.join("\n"))
      stdout(`Runtime target ${state.reportedTarget} matches ${first}.`)
      return 0
    }
    if (command === "verify") {
      const state = requireBinding(await readState(statePath))
      const target = normalizeRuntimeTarget(first)
      const errors = evaluateRuntimeTarget({ reportedTarget: state.reportedTarget, attemptedTarget: target, phase: "verify" })
      if (errors.length) throw new Error(errors.join("\n"))
      let expectedCommit
      try { expectedCommit = await repositoryCommit() } catch { throw new Error("Unable to determine the repository commit for runtime verification.") }
      if (!/^[a-f0-9]{7,64}$/i.test(expectedCommit)) throw new Error("Unable to determine the repository commit for runtime verification.")
      await verifyCapabilities(target, fetchImpl, expectedCommit)
      await writeState(statePath, { ...state, reportedTarget: target, status: "verified", verifiedTarget: target })
      stdout(`Runtime target ${target} is verified.`)
      return 0
    }
    if (command === "status") {
      const state = await readState(statePath)
      if (!state) stdout("No runtime target is bound.")
      else stdout(`Runtime target ${state.reportedTarget} is ${state.status}.`)
      return 0
    }
    if (command === "check") {
      const state = await readState(statePath)
      if (!state) { stdout("No runtime target is bound."); return 0 }
      const errors = evaluateRuntimeTargetState(state)
      if (errors.length) throw new Error(errors.join("\n"))
      stdout(`Runtime target ${state.reportedTarget} is ${state.status}.`)
      return 0
    }
    if (command === "clear") {
      const state = requireBinding(await readState(statePath))
      if (state.status !== "verified") throw new Error("The runtime target must be verified before it can be cleared.")
      await rm(statePath, { force: true })
      stdout(`Runtime target ${state.reportedTarget} was cleared.`)
      return 0
    }
    throw new Error("Usage: runtime-target <bind URL|assert PHASE URL|verify URL|status|check|clear>")
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runRuntimeTargetCli()
