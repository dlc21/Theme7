import { spawn } from "node:child_process"
import { createHmac } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import Database from "better-sqlite3"
import { WebSocket } from "ws"
import {
  advanceTerminalBinding,
  createTerminalBinding,
  ensureTerminalContinuitySchema,
  getTerminalBinding,
  setTerminalBindingIdentity,
} from "./terminal-binding-store.mjs"
import { signTerminalControlCapability } from "./terminal-control-capability.mjs"

const secret = "isolated-terminal-lifecycle-secret"
const laneId = "lifecycle-lane"
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-lifecycle-"))
const workspace = path.join(temporary, "workspace")
const databasePath = path.join(temporary, "theme7.sqlite")
const fakeSessionRoot = path.join(temporary, "omp-sessions")
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(fakeSessionRoot, { recursive: true })
const identityPlanPath = path.join(temporary, "fake-omp-identity-plan.txt")
const fakeOmpPidPath = path.join(temporary, "fake-omp-pids.txt")
const fakeOmpSource = path.join(temporary, "fake-omp.cjs")
fs.writeFileSync(fakeOmpSource, `
const fs = require("node:fs")
if (process.env.OPERATOR_ENGINE_FAKE_OMP_PID_FILE) fs.appendFileSync(process.env.OPERATOR_ENGINE_FAKE_OMP_PID_FILE, JSON.stringify({ pid: process.pid, parentPid: process.ppid, args: process.argv.slice(2) }) + "\\n")
function reportIdentity(sessionId) {
  if (!sessionId || !process.env.OPERATOR_ENGINE_OMP_IDENTITY_FILE || !process.env.OPERATOR_ENGINE_OMP_IDENTITY_NONCE) return
  fs.appendFileSync(process.env.OPERATOR_ENGINE_OMP_IDENTITY_FILE, JSON.stringify({
    version: 1,
    nonce: process.env.OPERATOR_ENGINE_OMP_IDENTITY_NONCE,
    sessionId,
    cwd: process.cwd(),
  }) + "\\n")
}
const identityPlan = process.env.OPERATOR_ENGINE_FAKE_OMP_IDENTITY_PLAN
if (identityPlan && fs.existsSync(identityPlan)) {
  const identities = fs.readFileSync(identityPlan, "utf8").split(/\\r?\\n/).filter(Boolean)
  const sessionId = identities.shift()
  fs.writeFileSync(identityPlan, identities.length ? identities.join("\\n") + "\\n" : "")
  reportIdentity(sessionId)
}
process.stdout.write("fake-omp-ready\\n")
process.stdin.setEncoding("utf8")
process.stdin.on("data", (data) => {
  const identity = String(data).match(/identity:([A-Za-z0-9._:-]{6,240})/)
  if (identity) reportIdentity(identity[1])
  if (data.includes("exit")) process.exit(0)
})
setInterval(() => undefined, 1_000)
`)
const fakeOmpExecutable = process.platform === "win32" ? path.join(temporary, "fake-omp.cmd") : path.join(temporary, "fake-omp")
if (process.platform === "win32") {
  fs.writeFileSync(fakeOmpExecutable, `@echo off\r\n"${process.execPath}" "${fakeOmpSource}" %*\r\n`)
} else {
  fs.writeFileSync(fakeOmpExecutable, `#!/usr/bin/env node\n${fs.readFileSync(fakeOmpSource, "utf8")}`)
  fs.chmodSync(fakeOmpExecutable, 0o755)
}

const database = new Database(databasePath)
database.pragma("journal_mode = WAL")
database.pragma("foreign_keys = ON")
database.exec(`
  CREATE TABLE lanes (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    layout_json TEXT,
    last_opened_at TEXT,
    default_harness TEXT NOT NULL
  )
`)
const filesLayout = { schemaVersion: 1, tree: { kind: "pane", id: "files-main", pane: "files" } }
database.prepare("INSERT INTO lanes (id, path, layout_json, last_opened_at, default_harness) VALUES (?, ?, ?, '', 'omp')")
  .run(laneId, workspace, JSON.stringify(filesLayout))
if (!ensureTerminalContinuitySchema(database)) throw new Error("Unable to initialize terminal continuity schema.")

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate an isolated port."))
      server.close(() => resolve(address.port))
    })
  })
}

function createBinding(paneId, harnessId = "shell") {
  const created = createTerminalBinding(database, { laneId, paneId, harnessId })
  if (!created || created === "epoch-conflict") throw new Error(`Unable to create binding for ${paneId}.`)
  return created
}

function advanceBinding(paneId, harnessId = "shell", resume = null) {
  const current = getTerminalBinding(database, laneId, paneId)
  if (!current) throw new Error(`Missing binding for ${paneId}.`)
  const advanced = advanceTerminalBinding(database, {
    laneId,
    paneId,
    expected: {
      generation: current.generation,
      harnessId: current.harnessId,
      resumeSessionId: current.resumeSessionId,
      kickoffSent: current.kickoffSent,
    },
    harnessId,
    resume,
  })
  if (!advanced) throw new Error(`Unable to advance binding for ${paneId}.`)
  return advanced
}

function makePaneVisible(paneId) {
  database.prepare("UPDATE lanes SET layout_json = ? WHERE id = ?").run(JSON.stringify({
    schemaVersion: 1,
    tree: {
      kind: "tabs",
      panes: [filesLayout.tree, { kind: "pane", id: paneId, pane: "terminal", config: { role: "additional" } }],
      activeId: paneId,
    },
  }), laneId)
}

function makeTerminalPanesVisible(paneIds) {
  database.prepare("UPDATE lanes SET layout_json = ? WHERE id = ?").run(JSON.stringify({
    schemaVersion: 1,
    tree: {
      kind: "tabs",
      panes: [
        filesLayout.tree,
        ...paneIds.map((paneId) => ({ kind: "pane", id: paneId, pane: "terminal", config: { role: "additional" } })),
      ],
      activeId: paneIds.at(-1),
    },
  }), laneId)
}

function ticket(paneId, { mode = "start", generation, controlGeneration = generation, harnessId = "shell", resumeSessionId } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("A ticket generation is required.")
  const payload = {
    laneId,
    paneId,
    harnessId,
    generation,
    mode,
    audience: "operator",
    runtimeIdentity: { sourceCommit: "abcdef123456", distribution: "theme-7", role: "candidate", mode: "standalone", webPort, terminalPort, dataClass: "isolated", releaseId: "lifecycle-smoke", contentSha256: "a".repeat(64) },
    ...(resumeSessionId ? { resumeSessionId } : {}),
    controlToken: signTerminalControlCapability({ laneId, paneId, generation: controlGeneration }, { NODE_ENV: "test", OPERATOR_ENGINE_TERMINAL_SECRET: secret }),
    expiresAt: Date.now() + 30_000,
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`
}

async function prewarm(port, paneId, generation, ttlMs, mode = "start") {
  const response = await fetch(`http://127.0.0.1:${port}/prewarm`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ ticket: ticket(paneId, { mode, generation, harnessId: "omp" }), ttlMs }),
  })
  const payload = await response.json()
  if (!response.ok || !Number.isFinite(payload.expiresAt)) throw new Error(`OMP prewarm failed: ${JSON.stringify(payload)}`)
  return payload
}

async function reserved(port, paneId, generation) {
  const response = await fetch(`http://127.0.0.1:${port}/prewarm/${laneId}/${paneId}/${generation}`, { headers: { authorization: `Bearer ${secret}` } })
  const payload = await response.json()
  if (!response.ok || typeof payload.reserved !== "boolean") throw new Error(`OMP prewarm lookup failed: ${JSON.stringify(payload)}`)
  return payload.reserved
}

function waitForHealth(port, sessions) {
  const deadline = Date.now() + 10_000
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`)
        const payload = await response.json()
        if (response.ok && payload.sessions === sessions) return resolve(payload)
      } catch { /* relay may still be starting */ }
      if (Date.now() >= deadline) return reject(new Error(`Relay did not report ${sessions} session(s).`))
      setTimeout(check, 100)
    }
    check()
  })
}

function connect(port, paneId, generation, {
  mode = "start",
  expected = "started",
  harnessId = "shell",
  resumeSessionId,
} = {}) {
  return new Promise((resolve, reject) => {
    const token = ticket(paneId, { mode, generation, harnessId, resumeSessionId })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal?ticket=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => { socket.close(); reject(new Error(`Timed out waiting for ${expected}.`)) }, 8_000)
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw))
      if (message.kind !== expected) return
      if (message.generation !== generation) {
        clearTimeout(timer)
        reject(new Error(`${expected} frame used generation ${String(message.generation)} instead of ${generation}.`))
        return
      }
      clearTimeout(timer)
      resolve({ socket, message })
    })
    socket.once("error", (error) => { clearTimeout(timer); reject(error) })
  })
}

function expectTicketRejected(port, paneId, generation, controlGeneration) {
  return new Promise((resolve, reject) => {
    const token = ticket(paneId, { generation, controlGeneration })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal?ticket=${encodeURIComponent(token)}`)
    let opened = false
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error("Relay accepted or stalled on a ticket whose nested control generation differed."))
    }, 8_000)
    socket.once("open", () => { opened = true })
    socket.once("error", () => {
      clearTimeout(timer)
      if (opened) reject(new Error("Relay upgraded a ticket whose nested control generation differed."))
      else resolve()
    })
    socket.once("close", () => {
      clearTimeout(timer)
      if (opened) reject(new Error("Relay upgraded a ticket whose nested control generation differed."))
      else resolve()
    })
  })
}

function connectForBufferedOutput(port, paneId, generation, expected) {
  return new Promise((resolve, reject) => {
    const token = ticket(paneId, { mode: "attach", generation })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal?ticket=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`Timed out waiting for buffered terminal output: ${expected}`))
    }, 8_000)
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw))
      if (message.kind !== "output" || !String(message.data ?? "").includes(expected)) return
      clearTimeout(timer)
      if (message.generation !== generation) {
        reject(new Error(`Buffered terminal output used generation ${String(message.generation)} instead of ${generation}.`))
        return
      }
      resolve(socket)
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function waitForOutput(socket, expected, expectedGeneration) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for terminal output: ${expected}`)), 8_000)
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw))
      if (message.kind !== "output" || !String(message.data ?? "").includes(expected)) return
      if (message.generation !== expectedGeneration) {
        clearTimeout(timer)
        socket.off("message", onMessage)
        reject(new Error(`Live terminal output used generation ${String(message.generation)} instead of ${expectedGeneration}.`))
        return
      }
      clearTimeout(timer)
      socket.off("message", onMessage)
      resolve()
    }
    socket.on("message", onMessage)
  })
}

function waitForBindingIdentity(paneId, sessionId) {
  const deadline = Date.now() + 8_000
  return new Promise((resolve, reject) => {
    const check = () => {
      const binding = getTerminalBinding(database, laneId, paneId)
      if (binding?.resumeSessionId === sessionId) return resolve(binding)
      if (Date.now() >= deadline) {
        let handshakes = "unavailable"
        try {
          handshakes = JSON.stringify(fs.readdirSync(path.join(temporary, "terminal-handshakes"), { recursive: true }))
        } catch { /* diagnostic only */ }
        return reject(new Error(`Terminal ${paneId} did not persist exact identity ${sessionId}; handshake files: ${handshakes}.`))
      }
      setTimeout(check, 50)
    }
    check()
  })
}

function fakeOmpProcesses() {
  if (!fs.existsSync(fakeOmpPidPath)) return []
  return fs.readFileSync(fakeOmpPidPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

function fakeOmpPids() {
  return fakeOmpProcesses().map(({ pid }) => pid)
}

function waitForFakeOmpStart(previousCount) {
  const deadline = Date.now() + 8_000
  return new Promise((resolve, reject) => {
    const check = () => {
      const pids = fakeOmpPids()
      if (pids.length > previousCount && Number.isSafeInteger(pids.at(-1))) return resolve(pids.at(-1))
      if (Date.now() >= deadline) return reject(new Error("The fake OMP child process did not start."))
      setTimeout(check, 50)
    }
    check()
  })
}

function waitForProcessExit(pid) {
  const deadline = Date.now() + 8_000
  return new Promise((resolve, reject) => {
    const check = () => {
      try { process.kill(pid, 0) }
      catch (error) {
        if (error?.code === "ESRCH") return resolve()
        return reject(error)
      }
      if (Date.now() >= deadline) return reject(new Error(`Terminal child process ${pid} survived relay shutdown.`))
      setTimeout(check, 50)
    }
    check()
  })
}

async function waitForFakeOmpProcessesExit() {
  const processes = fakeOmpProcesses()
  try {
    await Promise.all(processes.map(({ pid }) => waitForProcessExit(pid)))
  } catch (error) {
    const survivors = processes.filter(({ pid }) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
    throw new Error(`Fixture OMP process survived relay cleanup: ${JSON.stringify(survivors)}`, { cause: error })
  }
}


function closeSocket(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve()
    socket.once("close", resolve)
    socket.close()
  })
}

function waitForExit(socket, expectedGeneration) {
  return new Promise((resolve, reject) => {
    let honestStatus = false
    const timer = setTimeout(() => reject(new Error("Shell exit was not reported honestly.")), 8_000)
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw))
      if (message.kind === "exit" && message.generation === expectedGeneration && /exited with code 0\./.test(message.message ?? "")) honestStatus = true
    })
    socket.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 1000 || !honestStatus) return reject(new Error(`Expected honest exit status and close 1000; received ${code}.`))
      resolve()
    })
  })
}

const terminalPort = await freePort()
const webPort = await freePort()
const relayEnvironment = {
  ...process.env,
  NODE_ENV: "test",
  OPERATOR_ENGINE_DATA_DIR: temporary,
  OPERATOR_ENGINE_DB_PATH: databasePath,
  OPERATOR_ENGINE_WORKSPACE_ROOT: workspace,
  OPERATOR_ENGINE_TERMINAL_HOST: "127.0.0.1",
  OPERATOR_ENGINE_TERMINAL_PORT: String(terminalPort),
  OPERATOR_ENGINE_PORT: String(webPort),
  OPERATOR_ENGINE_TERMINAL_SECRET: secret,
  OPERATOR_ENGINE_ACCESS_PASSWORD: "fixture-access-password-xyz",
  OPERATOR_ENGINE_ACCESS_SESSION_SECRET: "fixture-access-session-secret-abc",
  OPERATOR_ENGINE_SOURCE_COMMIT: "abcdef123456",
  OPERATOR_ENGINE_DISTRIBUTION: "theme-7",
  OPERATOR_ENGINE_RUNTIME_DISTRIBUTION: "theme-7",
  OPERATOR_ENGINE_RUNTIME_ROLE: "candidate",
  OPERATOR_ENGINE_RUNTIME_MODE: "standalone",
  OPERATOR_ENGINE_DATA_CLASS: "isolated",
  OPERATOR_ENGINE_RELEASE_ID: "lifecycle-smoke",
  OPERATOR_ENGINE_CONTENT_SHA256: "a".repeat(64),
  OPERATOR_ENGINE_OMP_BIN: fakeOmpExecutable,
  OPERATOR_ENGINE_FAKE_OMP_IDENTITY_PLAN: identityPlanPath,
  OPERATOR_ENGINE_FAKE_OMP_PID_FILE: fakeOmpPidPath,
  OPERATOR_ENGINE_OMP_SESSION_ROOT: fakeSessionRoot,
}
let relayOutput = ""

function startRelay() {
  const relay = spawn(process.execPath, [path.join(process.cwd(), "scripts", "terminal-relay.mjs")], {
    cwd: process.cwd(),
    env: relayEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  relay.stdout.on("data", (chunk) => { relayOutput += String(chunk) })
  relay.stderr.on("data", (chunk) => { relayOutput += String(chunk) })
  return relay
}

function stopRelay(relay) {
  return new Promise((resolve) => {
    if (relay.exitCode !== null) {
      resolve()
      return
    }
    relay.once("exit", resolve)
    relay.kill("SIGTERM")
  })
}

let child = startRelay()

try {
  await waitForHealth(terminalPort, 0)
  await expectTicketRejected(terminalPort, "pane-control-mismatch", 1, 2)

  const expiringBinding = createBinding("pane-expiring", "omp")
  await prewarm(terminalPort, expiringBinding.paneId, expiringBinding.generation, 5_000)
  if (!await reserved(terminalPort, expiringBinding.paneId, expiringBinding.generation)) throw new Error("The prewarmed OMP session was not reported as reserved.")
  await prewarm(terminalPort, expiringBinding.paneId, expiringBinding.generation, 5_000, "attach")
  const duplicateBinding = createBinding("pane-duplicate-reserve", "omp")
  const duplicateReserve = await fetch(`http://127.0.0.1:${terminalPort}/prewarm`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ ticket: ticket(duplicateBinding.paneId, { generation: duplicateBinding.generation, harnessId: "omp" }), ttlMs: 5_000 }),
  })
  if (duplicateReserve.status !== 400) throw new Error(`A second lane reserve was accepted (${duplicateReserve.status}).`)
  await waitForHealth(terminalPort, 0)
  if (getTerminalBinding(database, laneId, expiringBinding.paneId)) throw new Error("Expired provisional binding was not deleted.")
  const earlyIdentityBinding = createBinding("pane-early-identity", "omp")
  const earlyIdentityId = "omp-session:prewarm-early"
  fs.writeFileSync(identityPlanPath, `${earlyIdentityId}\n`)
  await prewarm(terminalPort, earlyIdentityBinding.paneId, earlyIdentityBinding.generation, 15_000)
  await waitForBindingIdentity(earlyIdentityBinding.paneId, earlyIdentityId)
  await prewarm(terminalPort, earlyIdentityBinding.paneId, earlyIdentityBinding.generation, 15_000, "attach")
  if (!await reserved(terminalPort, earlyIdentityBinding.paneId, earlyIdentityBinding.generation)) {
    throw new Error("An exact-id OMP prewarm could not renew its reservation.")
  }
  const earlyIdentityCancel = await fetch(`http://127.0.0.1:${terminalPort}/prewarm/${laneId}/${earlyIdentityBinding.paneId}/${earlyIdentityBinding.generation}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  })
  const earlyIdentityCancelPayload = await earlyIdentityCancel.json()
  if (!earlyIdentityCancel.ok || earlyIdentityCancelPayload.cancelled !== true) {
    throw new Error(`Exact-id OMP prewarm cancellation failed: ${JSON.stringify(earlyIdentityCancelPayload)}`)
  }
  await waitForHealth(terminalPort, 0)
  const lateIdentityBinding = createBinding("pane-late-identity", "omp")
  const lateIdentityId = "omp-session:late-input"
  makePaneVisible(lateIdentityBinding.paneId)
  const lateIdentity = await connect(
    terminalPort,
    lateIdentityBinding.paneId,
    lateIdentityBinding.generation,
    { harnessId: "omp" },
  )
  await new Promise((resolve) => setTimeout(resolve, 5_500))
  lateIdentity.socket.send(JSON.stringify({ kind: "input", data: "discover-late-identity\n" }))
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  fs.writeFileSync(path.join(fakeSessionRoot, "late-session.jsonl"), `${JSON.stringify({
    type: "session",
    id: lateIdentityId,
    cwd: workspace,
    timestamp: new Date().toISOString(),
    title: "Late identity",
  })}\n`)
  await waitForBindingIdentity(lateIdentityBinding.paneId, lateIdentityId)
  const lateIdentityCleanup = await fetch(`http://127.0.0.1:${terminalPort}/sessions/${laneId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  })
  const lateIdentityCleanupPayload = await lateIdentityCleanup.json()
  if (!lateIdentityCleanup.ok || lateIdentityCleanupPayload.terminated !== 1) {
    throw new Error(`Late-identity cleanup failed: ${JSON.stringify(lateIdentityCleanupPayload)}`)
  }
  await closeSocket(lateIdentity.socket)
  await waitForHealth(terminalPort, 0)



  const warmBinding = createBinding("pane-warm", "omp")
  await prewarm(terminalPort, warmBinding.paneId, warmBinding.generation, 15_000)
  makePaneVisible(warmBinding.paneId)
  const warm = await connect(terminalPort, warmBinding.paneId, warmBinding.generation, { mode: "attach", harnessId: "omp" })
  if (await reserved(terminalPort, warmBinding.paneId, warmBinding.generation)) throw new Error("Attaching did not consume the OMP reserve.")
  if (!getTerminalBinding(database, laneId, warmBinding.paneId)) throw new Error("Consumed OMP binding was deleted.")
  const nextBinding = createBinding("pane-next", "omp")
  await prewarm(terminalPort, nextBinding.paneId, nextBinding.generation, 15_000)
  await waitForHealth(terminalPort, 2)
  const cancelledReserve = await fetch(`http://127.0.0.1:${terminalPort}/prewarm/${laneId}/${nextBinding.paneId}/${nextBinding.generation}`, { method: "DELETE", headers: { authorization: `Bearer ${secret}` } })
  const cancelledPayload = await cancelledReserve.json()
  if (!cancelledReserve.ok || cancelledPayload.cancelled !== true) throw new Error(`OMP reserve cancellation failed: ${JSON.stringify(cancelledPayload)}`)
  if (getTerminalBinding(database, laneId, nextBinding.paneId)) throw new Error("Cancelled provisional binding was retained.")
  await waitForHealth(terminalPort, 1)
  const cleanedWarm = await fetch(`http://127.0.0.1:${terminalPort}/sessions/${laneId}`, { method: "DELETE", headers: { authorization: `Bearer ${secret}` } })
  const cleanedWarmPayload = await cleanedWarm.json()
  if (!cleanedWarm.ok || cleanedWarmPayload.terminated !== 1) throw new Error(`Claimed OMP cleanup failed: ${JSON.stringify(cleanedWarmPayload)}`)
  await closeSocket(warm.socket)
  await waitForHealth(terminalPort, 0)

  const firstBinding = createBinding("pane-one")
  const first = await connect(terminalPort, firstBinding.paneId, firstBinding.generation)
  const duplicate = await connect(terminalPort, firstBinding.paneId, firstBinding.generation, { mode: "attach" })
  await waitForHealth(terminalPort, 1)
  await closeSocket(first.socket)
  await waitForHealth(terminalPort, 1)
  await closeSocket(duplicate.socket)
  await waitForHealth(terminalPort, 1)

  const reattached = await connect(terminalPort, firstBinding.paneId, firstBinding.generation, { mode: "attach" })
  const replaced = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The replaced shell session did not close.")), 8_000)
    reattached.socket.once("close", (code) => {
      clearTimeout(timer)
      if (code !== 1000) return reject(new Error(`The replaced shell session closed with ${code}.`))
      resolve()
    })
  })
  const replacementBinding = advanceBinding(firstBinding.paneId)
  const restarted = await connect(terminalPort, replacementBinding.paneId, replacementBinding.generation)
  await replaced
  await waitForHealth(terminalPort, 1)
  const runtimeMarker = "candidate|standalone|theme-7|" + webPort + "|" + terminalPort + "|isolated|abcdef123456|lifecycle-smoke|" + "a".repeat(64)
  const runtimeOutput = waitForOutput(restarted.socket, runtimeMarker, replacementBinding.generation)
  const runtimeCommand = `node -e "console.log(['OPERATOR_ENGINE_RUNTIME_ROLE','OPERATOR_ENGINE_RUNTIME_MODE','OPERATOR_ENGINE_RUNTIME_DISTRIBUTION','OPERATOR_ENGINE_WEB_PORT','OPERATOR_ENGINE_TERMINAL_PORT','OPERATOR_ENGINE_DATA_CLASS','OPERATOR_ENGINE_SOURCE_COMMIT','OPERATOR_ENGINE_RELEASE_ID','OPERATOR_ENGINE_CONTENT_SHA256'].map(k=>process.env[k]).join('|'))"`
  restarted.socket.send(JSON.stringify({ kind: "input", data: `${runtimeCommand}${process.platform === "win32" ? "\r" : "\n"}` }))
  await runtimeOutput

  const secretsMarker = "secrets-are-absent"
  const secretsOutput = waitForOutput(restarted.socket, secretsMarker, replacementBinding.generation)
  const secretsCommand = `node -e "console.log(['OPERATOR_ENGINE_ACCESS_PASSWORD','OPERATOR_ENGINE_ACCESS_SESSION_SECRET','OPERATOR_ENGINE_TERMINAL_SECRET'].every(k=>process.env[k]===undefined)?'secrets-are-absent':'secrets-present')"`
  restarted.socket.send(JSON.stringify({ kind: "input", data: `${secretsCommand}${process.platform === "win32" ? "\r" : "\n"}` }))
  await secretsOutput
  const bufferedClient = await connectForBufferedOutput(terminalPort, replacementBinding.paneId, replacementBinding.generation, runtimeMarker)
  await closeSocket(bufferedClient)

  const siblingBinding = createBinding("pane-sibling")
  const sibling = await connect(terminalPort, siblingBinding.paneId, siblingBinding.generation)
  await waitForHealth(terminalPort, 2)
  const paneClosed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Exact pane cleanup did not close its terminal.")), 8_000)
    restarted.socket.once("close", () => { clearTimeout(timer); resolve() })
  })
  const paneCleanup = await fetch(`http://127.0.0.1:${terminalPort}/sessions/${laneId}/${replacementBinding.paneId}/${replacementBinding.generation}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  })
  const paneCleanupPayload = await paneCleanup.json()
  if (!paneCleanup.ok || paneCleanupPayload.terminated !== 1) throw new Error(`Exact pane cleanup failed: ${JSON.stringify(paneCleanupPayload)}`)
  await paneClosed
  await waitForHealth(terminalPort, 1)
  const siblingMarker = `sibling-survived-${Date.now()}`
  const siblingOutput = waitForOutput(sibling.socket, siblingMarker, siblingBinding.generation)
  sibling.socket.send(JSON.stringify({ kind: "input", data: `echo ${siblingMarker}${process.platform === "win32" ? "\r" : "\n"}` }))
  await siblingOutput

  const recreatedBinding = advanceBinding(firstBinding.paneId)
  const recreated = await connect(terminalPort, recreatedBinding.paneId, recreatedBinding.generation)
  await waitForHealth(terminalPort, 2)
  const staleCleanup = await fetch(`http://127.0.0.1:${terminalPort}/sessions/${laneId}/${replacementBinding.paneId}/${replacementBinding.generation}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  })
  const staleCleanupPayload = await staleCleanup.json()
  if (!staleCleanup.ok || staleCleanupPayload.terminated !== 0) throw new Error(`Stale pane cleanup reached a newer generation: ${JSON.stringify(staleCleanupPayload)}`)
  await waitForHealth(terminalPort, 2)
  const notStartedReplacement = advanceBinding(recreatedBinding.paneId)
  const boundedCleanup = await fetch(`http://127.0.0.1:${terminalPort}/sessions/${laneId}/${notStartedReplacement.paneId}/${notStartedReplacement.generation}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  })
  const boundedCleanupPayload = await boundedCleanup.json()
  if (!boundedCleanup.ok || boundedCleanupPayload.terminated !== 1) {
    throw new Error(`A delayed pane cleanup did not remove its older orphan: ${JSON.stringify(boundedCleanupPayload)}`)
  }
  await waitForHealth(terminalPort, 1)


  const denied = await fetch(`http://127.0.0.1:${terminalPort}/sessions/${laneId}`, { method: "DELETE", headers: { authorization: "Bearer wrong" } })
  if (denied.status !== 403) throw new Error(`Lane cleanup accepted a bad secret (${denied.status}).`)
  await waitForHealth(terminalPort, 1)

  const cleaned = await fetch(`http://127.0.0.1:${terminalPort}/sessions/${laneId}`, { method: "DELETE", headers: { authorization: `Bearer ${secret}` } })
  const cleanup = await cleaned.json()
  if (!cleaned.ok || cleanup.terminated !== 1) throw new Error(`Lane cleanup failed: ${JSON.stringify(cleanup)}`)
  await closeSocket(sibling.socket)
  await closeSocket(recreated.socket)
  await waitForHealth(terminalPort, 0)
  const firstIdentityBinding = createBinding("pane-identity-first", "omp")
  const secondIdentityBinding = createBinding("pane-identity-second", "omp")
  makeTerminalPanesVisible([firstIdentityBinding.paneId, secondIdentityBinding.paneId])
  const sharedIdentity = "omp-session:duplicate-live"
  fs.writeFileSync(identityPlanPath, `${sharedIdentity}\n`)
  const firstIdentity = await connect(
    terminalPort,
    firstIdentityBinding.paneId,
    firstIdentityBinding.generation,
    { harnessId: "omp" },
  )
  await waitForBindingIdentity(firstIdentityBinding.paneId, sharedIdentity)
  await waitForHealth(terminalPort, 1)
  fs.writeFileSync(identityPlanPath, `${sharedIdentity}\n`)
  const secondIdentity = await connect(
    terminalPort,
    secondIdentityBinding.paneId,
    secondIdentityBinding.generation,
    { harnessId: "omp", expected: "error" },
  )
  if (!String(secondIdentity.message.message ?? "").startsWith("Duplicate terminal session binding")) {
    throw new Error(`Conflicting OMP identity returned the wrong error: ${JSON.stringify(secondIdentity.message)}`)
  }
  await waitForHealth(terminalPort, 1)
  if (firstIdentity.socket.readyState !== WebSocket.OPEN) throw new Error("Duplicate identity handling killed the established OMP process.")
  if (getTerminalBinding(database, laneId, secondIdentityBinding.paneId)?.resumeSessionId !== null) {
    throw new Error("Duplicate identity handling persisted the conflicting OMP identity.")
  }
  const identityCleanup = await fetch(`http://127.0.0.1:${terminalPort}/sessions/${laneId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  })
  const identityCleanupPayload = await identityCleanup.json()
  if (!identityCleanup.ok || identityCleanupPayload.terminated !== 1) {
    throw new Error(`Duplicate identity survivor cleanup failed: ${JSON.stringify(identityCleanupPayload)}`)
  }
  await closeSocket(firstIdentity.socket)
  await closeSocket(secondIdentity.socket)
  await waitForHealth(terminalPort, 0)


  const exactSessionId = "omp-session:relay-restart"
  const exactSeed = createBinding("pane-exact-restart", "omp")
  makePaneVisible(exactSeed.paneId)
  const exactIdentified = setTerminalBindingIdentity(database, {
    laneId,
    paneId: exactSeed.paneId,
    generation: exactSeed.generation,
    resumeSessionId: exactSessionId,
  })
  if (!exactIdentified) throw new Error("Unable to persist the exact OMP smoke binding.")
  const exactBeforeRestartBinding = advanceBinding(exactSeed.paneId, "omp", exactSessionId)
  const fakeOmpCountBeforeRestart = fakeOmpPids().length
  const exactBeforeRestart = await connect(
    terminalPort,
    exactBeforeRestartBinding.paneId,
    exactBeforeRestartBinding.generation,
    { mode: "resume-exact", harnessId: "omp", resumeSessionId: exactSessionId },
  )
  const exactBeforeRestartPid = await waitForFakeOmpStart(fakeOmpCountBeforeRestart)
  await waitForHealth(terminalPort, 1)
  const { promise: relayClosedSocket, resolve: resolveRelayClosedSocket } = Promise.withResolvers()
  exactBeforeRestart.socket.once("close", resolveRelayClosedSocket)
  await stopRelay(child)
  await relayClosedSocket
  await waitForProcessExit(exactBeforeRestartPid)

  child = startRelay()
  await waitForHealth(terminalPort, 0)
  const missingAfterRestart = await connect(
    terminalPort,
    exactBeforeRestartBinding.paneId,
    exactBeforeRestartBinding.generation,
    { mode: "attach", expected: "missing", harnessId: "omp" },
  )
  await closeSocket(missingAfterRestart.socket)
  const exactAfterRestartBinding = advanceBinding(exactSeed.paneId, "omp", exactSessionId)
  const exactAfterRestart = await connect(
    terminalPort,
    exactAfterRestartBinding.paneId,
    exactAfterRestartBinding.generation,
    { mode: "resume-exact", harnessId: "omp", resumeSessionId: exactSessionId },
  )
  const exactSecondClient = await connect(
    terminalPort,
    exactAfterRestartBinding.paneId,
    exactAfterRestartBinding.generation,
    { mode: "attach", harnessId: "omp" },
  )
  await waitForHealth(terminalPort, 1)
  await closeSocket(exactAfterRestart.socket)
  await closeSocket(exactSecondClient.socket)
  await waitForHealth(terminalPort, 1)
  const exactCleanup = await fetch(`http://127.0.0.1:${terminalPort}/sessions/${laneId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
  })
  const exactCleanupPayload = await exactCleanup.json()
  if (!exactCleanup.ok || exactCleanupPayload.terminated !== 1) {
    throw new Error(`Relay-restarted exact OMP cleanup failed: ${JSON.stringify(exactCleanupPayload)}`)
  }
  await waitForHealth(terminalPort, 0)

  const exitBinding = createBinding("pane-exit")
  const exiting = await connect(terminalPort, exitBinding.paneId, exitBinding.generation)
  const exited = waitForExit(exiting.socket, exitBinding.generation)
  exiting.socket.send(process.platform === "win32" ? JSON.stringify({ kind: "input", data: "exit\r" }) : JSON.stringify({ kind: "input", data: "exit\n" }))
  await exited
  await waitForHealth(terminalPort, 0)

  process.stdout.write("Terminal lifecycle smoke passed: nested-control generation rejection, generation-tagged live and buffered output, durable OMP reserve settlement including early exact-id renewal, input-triggered late identity fallback, two-client detach-only continuity, exact-generation replacement, pane-scoped cleanup with surviving sibling and generation-bounded stale cleanup, duplicate live OMP identity rejection with established-session survival, relay-restart exact OMP recovery, authorized lane cleanup, and honest exit.\n")
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\nRelay output:\n${relayOutput}\n`)
  process.exitCode = 1
} finally {
  await stopRelay(child)
  await waitForFakeOmpProcessesExit()
  database.close()
  let cleanupRoot = temporary
  try {
    cleanupRoot = `${temporary}.cleanup-${process.pid}`
    fs.renameSync(temporary, cleanupRoot)
  } catch {
    cleanupRoot = temporary
  }
  fs.rmSync(cleanupRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
