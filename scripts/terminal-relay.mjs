import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

import Database from "better-sqlite3"
import { WebSocketServer, WebSocket } from "ws"

import { detectHarnesses, harnessAdapters } from "./harness-adapters.mjs"
import { reviewedServerResources } from "./distribution-adapters.mjs"
import { resolveRuntimeHosts, resolveRuntimePaths, resolveRuntimePorts, terminalSecret, webControlOrigin } from "./runtime-config-core.mjs"
import { verifyTerminalControlCapability } from "./terminal-control-capability.mjs"
import { isRuntimeIdentity } from "./runtime-identity-policy.mjs"
import { isPathInside } from "./path-policy.mjs"
import {
  deleteAbandonedTerminalBindings,
  ensureTerminalContinuitySchema,
  getTerminalBinding,
  markTerminalGuidanceStarted,
  setTerminalBindingIdentity,
  settleTerminalReservation,
} from "./terminal-binding-store.mjs"
import { handleInboundFrame, isAllowedOutboundFrame, sanitizeOutboundMessage } from "./terminal-spectator-policy.mjs"
import { loadTheme7SessionRecords, theme7Selected } from "./theme-7-loader.mjs"

const require = createRequire(import.meta.url)
const nodePty = require("@lydell/node-pty")
const sessionRecords = await loadTheme7SessionRecords({ required: theme7Selected() })
const findRecentOmpSession = sessionRecords?.findRecentOmpSession ?? (async () => null)
const readOmpSessionMetadata = sessionRecords?.readOmpSessionMetadata ?? (async () => null)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimePaths = resolveRuntimePaths()
const { dataDirectory, databasePath, workspaceRoots } = runtimePaths
const { terminalPort: port } = resolveRuntimePorts()
const { terminalHost: host } = resolveRuntimeHosts()
const secret = terminalSecret()
const controlOrigin = webControlOrigin()
const helperDirectory = path.join(root, "scripts", "bin")
const identityExtension = reviewedServerResources.omp?.identityExtension
const identityDirectory = path.join(dataDirectory, "terminal-handshakes", String(process.pid))
const executablePathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"
const sessions = new Map()
const MAX_SESSIONS = 16
const MAX_BUFFER = 256_000
const DEFAULT_PREWARM_TTL_MS = 60_000
const MIN_PREWARM_TTL_MS = 5_000
const MAX_PREWARM_TTL_MS = 300_000
const IDENTITY_FALLBACK_DELAY_MS = 5_000
const IDENTITY_INPUT_FALLBACK_DELAY_MS = 1_000
const IDENTITY_INPUT_FALLBACK_MAX_DELAY_MS = 5_000
const IDENTITY_PERSIST_RETRIES = 8
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

fs.mkdirSync(identityDirectory, { recursive: true })
const relayStartedAt = new Date().toISOString()
fs.mkdirSync(path.dirname(databasePath), { recursive: true })
const continuityDb = new Database(databasePath)
continuityDb.pragma("journal_mode = WAL")
continuityDb.pragma("foreign_keys = ON")
let continuitySwept = false
continuityReady()

function continuityReady() {
  const ready = ensureTerminalContinuitySchema(continuityDb)
  if (ready && !continuitySwept) {
    deleteAbandonedTerminalBindings(continuityDb, relayStartedAt)
    continuitySwept = true
  }
  return ready
}



function loopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

function authorized(request) {
  const value = request.headers.authorization
  if (!value?.startsWith("Bearer ")) return false
  const received = Buffer.from(value.slice(7))
  const expected = Buffer.from(secret)
  return received.length === expected.length && timingSafeEqual(received, expected)
}

function terminatePtyProcessTree(pty) {
  if (process.platform === "win32" && Number.isSafeInteger(pty.pid) && pty.pid > 0) {
    try {
      spawnSync("taskkill.exe", ["/PID", String(pty.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 2_000,
        windowsHide: true,
      })
    } catch { /* node-pty remains the portable fallback */ }
  }
  try { pty.kill() } catch { /* the process may already have exited */ }
}

function terminateLaneSessions(laneId) {
  let terminated = 0
  for (const [key, session] of sessions) {
    if (!key.startsWith(`${laneId}:`)) continue
    sessions.delete(key)
    clearReservation(session)
    clearSessionTracking(session)
    terminatePtyProcessTree(session.pty)
    terminated += 1
  }
  return terminated
}

function terminatePaneSession(laneId, paneId, deletedGeneration) {
  const key = `${laneId}:${paneId}`
  const session = sessions.get(key)
  if (!session || session.generation > deletedGeneration) return 0
  sessions.delete(key)
  clearReservation(session)
  clearSessionTracking(session)
  terminatePtyProcessTree(session.pty)
  return 1
}


function verifyTicket(token) {
  const [body, signature, extra] = String(token ?? "").split(".")
  if (!body || !signature || extra) return null
  const expected = createHmac("sha256", secret).update(body).digest()
  let received
  try { received = Buffer.from(signature, "base64url") } catch { return null }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    if (!ID_PATTERN.test(payload.laneId) || !ID_PATTERN.test(payload.paneId)) return null
    if (!harnessAdapters[payload.harnessId]) return null
    if (!Number.isSafeInteger(payload.generation) || payload.generation < 1) return null
    if (!isRuntimeIdentity(payload.runtimeIdentity)) return null
    if (!Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now()) return null

    if (payload.audience === "operator") {
      if (payload.mode !== "attach" && payload.mode !== "start" && payload.mode !== "resume-exact" && payload.mode !== "choose-omp-session") return null
      if (payload.systemPrompt !== undefined && (typeof payload.systemPrompt !== "string" || payload.systemPrompt.length > 32_000)) return null
      if (payload.resumeSessionId !== undefined && (typeof payload.resumeSessionId !== "string" || !/^[A-Za-z0-9._:-]{6,240}$/.test(payload.resumeSessionId))) return null
      if (payload.guidanceIncluded !== undefined && typeof payload.guidanceIncluded !== "boolean") return null
      if (payload.mode === "attach" && (payload.systemPrompt !== undefined || payload.resumeSessionId !== undefined || payload.guidanceIncluded !== undefined)) return null
      if (payload.mode === "start" && payload.resumeSessionId !== undefined) return null
      if (payload.mode === "resume-exact" && (payload.harnessId !== "omp" || !payload.resumeSessionId || payload.systemPrompt !== undefined || payload.guidanceIncluded !== undefined)) return null
      if (payload.mode === "choose-omp-session" && (payload.harnessId !== "omp" || payload.resumeSessionId !== undefined || payload.systemPrompt !== undefined || payload.guidanceIncluded !== undefined)) return null
      if (typeof payload.controlToken !== "string" || payload.controlToken.length > 2_048) return null
      const previewControl = verifyTerminalControlCapability(payload.controlToken, "open_web_preview")
      const closeControl = verifyTerminalControlCapability(payload.controlToken, "close_terminal")
      if (!previewControl || !closeControl) return null
      if (previewControl.laneId !== payload.laneId || previewControl.paneId !== payload.paneId || previewControl.generation !== payload.generation) return null
      if (closeControl.laneId !== payload.laneId || closeControl.paneId !== payload.paneId || closeControl.generation !== payload.generation) return null
      return payload
    }

    if (payload.audience === "spectator") {
      if ("controlToken" in payload && payload.controlToken !== undefined) return null
      if (payload.mode !== "attach") return null
      if (payload.systemPrompt !== undefined || payload.resumeSessionId !== undefined || payload.guidanceIncluded !== undefined) return null
      return payload
    }

    return null
  } catch { return null }
}
async function requestJson(request) {
  let body = ""
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 64 * 1024) throw new Error("Request body is too large.")
    body += String(chunk)
  }
  return JSON.parse(body || "{}")
}

function clearReservation(session) {
  clearTimeout(session.reservationTimer)
  session.reservationTimer = null
  session.reservationExpiresAt = null
  session.reserved = false
}

const reservationOperations = new Map()

function serializeReservation(laneId, paneId, operation) {
  const key = `${laneId}:${paneId}`
  const previous = reservationOperations.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  reservationOperations.set(key, current)
  void current.then(
    () => { if (reservationOperations.get(key) === current) reservationOperations.delete(key) },
    () => { if (reservationOperations.get(key) === current) reservationOperations.delete(key) },
  )
  return current
}

function settleReservedSession(laneId, paneId, generation) {
  if (!continuityReady()) throw new Error("Terminal continuity schema is not ready.")
  const settlement = settleTerminalReservation(continuityDb, { laneId, paneId, generation })
  const key = `${laneId}:${paneId}`
  const session = sessions.get(key)
  if (!session || session.generation !== generation) {
    return { status: settlement.status, cancelled: settlement.status === "deleted" }
  }
  clearReservation(session)
  if (settlement.status === "consumed") return { status: settlement.status, cancelled: false }
  if (sessions.get(key) === session) sessions.delete(key)
  clearSessionTracking(session)
  terminatePtyProcessTree(session.pty)
  return { status: settlement.status, cancelled: true }
}

function reserveSession(identity, requestedTtlMs) {
  if (identity.harnessId !== "omp" || (identity.mode !== "start" && identity.mode !== "attach") || identity.resumeSessionId) {
    throw new Error("Only an unbound OMP session can be prewarmed.")
  }
  const key = `${identity.laneId}:${identity.paneId}`
  const otherReservation = [...sessions.values()].find((candidate) => candidate.reserved && candidate.key !== key && candidate.key.startsWith(`${identity.laneId}:`))
  if (otherReservation) throw new Error("This lane already has a prewarmed OMP terminal.")
  let session = sessions.get(key)
  if (identity.mode === "attach") {
    session = openSession(identity)
    if (!session?.reserved || session.generation !== identity.generation) throw new Error("OMP prewarm reservation is no longer live.")
  } else if (session && !session.exited) {
    if (!session.reserved || session.harnessId !== "omp" || session.generation !== identity.generation) {
      throw new Error("Terminal identity is already active.")
    }
  } else {
    session = openSession(identity)
  }
  const ttlMs = Math.min(MAX_PREWARM_TTL_MS, Math.max(MIN_PREWARM_TTL_MS, Number(requestedTtlMs) || DEFAULT_PREWARM_TTL_MS))
  clearReservation(session)
  session.reserved = true
  session.reservationExpiresAt = Date.now() + ttlMs
  session.reservationTimer = setTimeout(() => {
    if (sessions.get(key) !== session || !session.reserved) return
    void serializeReservation(identity.laneId, identity.paneId, () => settleReservedSession(identity.laneId, identity.paneId, identity.generation))
  }, ttlMs)
  session.reservationTimer.unref?.()
  return session
}

function hasReservedSession(laneId, paneId, generation) {
  const session = sessions.get(`${laneId}:${paneId}`)
  return Boolean(session?.reserved && !session.exited && session.harnessId === "omp" && session.generation === generation)
}

function laneDirectory(laneId) {
  if (!continuityReady()) throw new Error("Terminal continuity schema is not ready.")
  const row = continuityDb.prepare("SELECT path FROM lanes WHERE id = ?").get(laneId)
  if (!row?.path) throw new Error("Lane not found.")
  const roots = workspaceRoots.map((root) => fs.realpathSync(root))
  const directory = fs.realpathSync(row.path)
  if (!roots.some((root) => isPathInside(root, directory))) throw new Error("Lane directory escapes configured workspace roots.")
  return directory
}


function markGuidanceStarted(laneId, paneId, generation) {
  if (!continuityReady()) throw new Error("Terminal continuity schema is not ready.")
  const binding = markTerminalGuidanceStarted(continuityDb, { laneId, paneId, generation })
  if (!binding) throw new Error("Terminal binding changed before guidance started.")
  return binding
}

function rememberResumeSession(session, resumeSessionId) {
  if (sessions.get(session.key) !== session || session.exited) return null
  if (!continuityReady()) throw new Error("Terminal continuity schema is not ready.")
  return setTerminalBindingIdentity(continuityDb, {
    laneId: session.laneId,
    paneId: session.paneId,
    generation: session.generation,
    resumeSessionId,
  })
}

function sendClientMessage(client, message) {
  if (client.readyState === WebSocket.OPEN) {
    const sanitized = sanitizeOutboundMessage(client.audience, message)
    if (sanitized) client.send(JSON.stringify(sanitized))
  }
}

function broadcast(session, message) {
  for (const client of session.clients) {
    sendClientMessage(client, message)
  }
}

function sameOpaqueValue(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false
  const receivedBytes = Buffer.from(received)
  const expectedBytes = Buffer.from(expected)
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
}

function sessionCwdMatches(session, candidate) {
  if (typeof candidate !== "string" || !candidate) return false
  return isPathInside(path.resolve(candidate), path.resolve(session.cwd))
}

function clearSessionTracking(session) {
  clearTimeout(session.identityFallbackTimer)
  clearTimeout(session.identityPersistTimer)
  clearTimeout(session.metadataDebounceTimer)
  if (session.identityFile && session.identityWatchListener) fs.unwatchFile(session.identityFile, session.identityWatchListener)
  if (session.sessionFile && session.metadataWatchListener) fs.unwatchFile(session.sessionFile, session.metadataWatchListener)
  session.identityWatchListener = null
  session.metadataWatchListener = null
  if (session.identityFile) void fs.promises.rm(session.identityFile, { force: true }).catch(() => undefined)
}

function scheduleIdentityPersistence(session, reset = false) {
  if (!session.resumeSessionId || session.identityPersistedId === session.resumeSessionId) return
  if (reset) session.identityPersistAttempts = 0
  clearTimeout(session.identityPersistTimer)
  const expectedId = session.resumeSessionId
  const persist = () => {
    if (sessions.get(session.key) !== session || session.exited || session.resumeSessionId !== expectedId || session.identityPersistedId === expectedId) return
    try {
      const binding = rememberResumeSession(session, expectedId)
      if (!binding) {
        sessions.delete(session.key)
        clearSessionTracking(session)
        terminatePtyProcessTree(session.pty)
        return
      }
      session.identityPersistedId = expectedId
      session.identityPersistAttempts = 0
      const { laneId: _laneId, ...publicBinding } = binding
      broadcast(session, { kind: "binding", generation: session.generation, binding: publicBinding })
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("Duplicate terminal session binding") || error.message.startsWith("Conflicting terminal session sources"))) {
        broadcast(session, { kind: "error", generation: session.generation, message: error.message })
        if (sessions.get(session.key) === session) sessions.delete(session.key)
        clearSessionTracking(session)
        terminatePtyProcessTree(session.pty)
        return
      }
      session.identityPersistAttempts += 1
      if (session.identityPersistAttempts >= IDENTITY_PERSIST_RETRIES) return
      const delay = Math.min(2_000, 100 * (2 ** (session.identityPersistAttempts - 1)))
      session.identityPersistTimer = setTimeout(persist, delay)
      session.identityPersistTimer.unref?.()
    }
  }
  session.identityPersistTimer = setTimeout(persist, 0)
  session.identityPersistTimer.unref?.()
}

async function refreshSessionMetadata(session) {
  if (sessions.get(session.key) !== session || session.exited || !session.sessionFile || session.metadataReading) return
  session.metadataReading = true
  try {
    const metadata = await readOmpSessionMetadata(session.sessionFile)
    if (sessions.get(session.key) !== session || session.exited || !metadata || metadata.id !== session.resumeSessionId || !sessionCwdMatches(session, metadata.cwd)) return
    if (metadata.title && metadata.title !== session.sessionTitle) {
      session.sessionTitle = metadata.title
      broadcast(session, { kind: "session", generation: session.generation, title: metadata.title })
    }
  } catch { /* metadata remains best effort */ }
  finally { session.metadataReading = false }
}

function watchSessionMetadata(session, file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !file.endsWith(".jsonl")) return
  const resolved = path.resolve(file)
  if (session.sessionFile === resolved && session.metadataWatchListener) return
  if (session.sessionFile && session.metadataWatchListener) fs.unwatchFile(session.sessionFile, session.metadataWatchListener)
  session.sessionFile = resolved
  session.metadataWatchListener = () => {
    clearTimeout(session.metadataDebounceTimer)
    session.metadataDebounceTimer = setTimeout(() => void refreshSessionMetadata(session), 250)
    session.metadataDebounceTimer.unref?.()
  }
  fs.watchFile(resolved, { interval: 500, persistent: false }, session.metadataWatchListener)
  void refreshSessionMetadata(session)
}

function acceptSessionIdentity(session, { sessionId, sessionFile }) {
  if (sessions.get(session.key) !== session || session.exited) return false
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._:-]{6,240}$/.test(sessionId)) return false
  const duplicate = [...sessions.values()].find((candidate) =>
    candidate !== session && !candidate.exited && candidate.resumeSessionId === sessionId)
  if (duplicate) {
    const established = duplicate.identityPersistedId === sessionId
      ? duplicate
      : session.identityPersistedId === sessionId
        ? session
        : duplicate.startedAt <= session.startedAt ? duplicate : session
    const conflicting = established === session ? duplicate : session
    const message = `Duplicate terminal session binding for ${sessionId} between ${established.laneId}/${established.paneId} and ${conflicting.laneId}/${conflicting.paneId}.`
    broadcast(conflicting, { kind: "error", generation: conflicting.generation, message })
    if (sessions.get(conflicting.key) === conflicting) sessions.delete(conflicting.key)
    clearSessionTracking(conflicting)
    terminatePtyProcessTree(conflicting.pty)
    if (conflicting === session) return false
  }
  if (session.resumeSessionId !== sessionId) {
    session.resumeSessionId = sessionId
    session.identityPersistedId = null
    session.identityPersistAttempts = 0
    scheduleIdentityPersistence(session)
  }
  if (sessionFile) watchSessionMetadata(session, sessionFile)
  session.identityObserved = true
  return true
}

async function readIdentityHandshake(session) {
  if (sessions.get(session.key) !== session || session.exited || !session.identityFile || session.identityReading) return
  session.identityReading = true
  try {
    const content = await fs.promises.readFile(session.identityFile, "utf8")
    if (Buffer.byteLength(content) > 64 * 1024) return
    const completeLines = content.split(/\r?\n/)
    completeLines.pop()
    for (const line of completeLines.slice(session.identityProcessedLines)) {
      session.identityProcessedLines += 1
      let record
      try { record = JSON.parse(line) } catch { continue }
      if (record?.version !== 1 || !sameOpaqueValue(record.nonce, session.identityNonce) || !sessionCwdMatches(session, record.cwd)) continue
      acceptSessionIdentity(session, record)
    }
  } catch (error) {
    if (error?.code !== "ENOENT") session.identityReadFailed = true
  } finally { session.identityReading = false }
}

function scheduleIdentityFallback(session, delayMs = IDENTITY_FALLBACK_DELAY_MS, retry = false) {
  if (session.harnessId !== "omp" || session.identityObserved || session.exited) return
  clearTimeout(session.identityFallbackTimer)
  const expectedGeneration = session.generation
  const token = session.identityFallbackToken + 1
  session.identityFallbackToken = token
  session.identityFallbackTimer = setTimeout(async () => {
    if (sessions.get(session.key) !== session || session.exited || session.identityObserved ||
        session.generation !== expectedGeneration || session.identityFallbackToken !== token) return
    if (session.identityFallbackReading) {
      if (retry) scheduleIdentityFallback(session, delayMs, true)
      return
    }
    session.identityFallbackReading = true
    try {
      const rootOverride = process.env.OPERATOR_ENGINE_OMP_SESSION_ROOT?.trim() || undefined
      const metadata = await findRecentOmpSession(session.cwd, session.startedAt - 2_000, rootOverride)
      if (sessions.get(session.key) === session && !session.exited && !session.identityObserved &&
          session.generation === expectedGeneration && session.identityFallbackToken === token && metadata) {
        acceptSessionIdentity(session, { sessionId: metadata.id, sessionFile: metadata.file })
      }
    } catch { /* an unavailable session store leaves the terminal live but untracked */ }
    finally { session.identityFallbackReading = false }
    if (retry && sessions.get(session.key) === session && !session.exited && !session.identityObserved &&
        session.generation === expectedGeneration && session.identityFallbackToken === token) {
      scheduleIdentityFallback(
        session,
        Math.min(IDENTITY_INPUT_FALLBACK_MAX_DELAY_MS, Math.max(IDENTITY_INPUT_FALLBACK_DELAY_MS, delayMs * 2)),
        true,
      )
    }
  }, delayMs)
  session.identityFallbackTimer.unref?.()
}

function startIdentityTracking(session, identity) {
  if (session.identityFile) {
    session.identityWatchListener = () => void readIdentityHandshake(session)
    fs.watchFile(session.identityFile, { interval: 100, persistent: false }, session.identityWatchListener)
    setTimeout(() => void readIdentityHandshake(session), 25).unref?.()
  }
  if (identity.mode !== "resume-exact") scheduleIdentityFallback(session)
}

function openSession(identity) {
  if (!continuityReady()) throw new Error("Terminal continuity schema is not ready.")
  const binding = getTerminalBinding(continuityDb, identity.laneId, identity.paneId)
  if (!binding) throw new Error("Terminal pane has no durable binding.")
  if (binding.generation !== identity.generation || binding.harnessId !== identity.harnessId) {
    throw new Error("Terminal ticket is stale.")
  }
  if (identity.mode === "resume-exact" && binding.resumeSessionId !== identity.resumeSessionId) {
    throw new Error("Terminal ticket does not match the exact bound OMP session.")
  }
  if ((identity.mode === "start" || identity.mode === "choose-omp-session") && binding.resumeSessionId !== null) {
    throw new Error("Terminal ticket cannot replace a bound OMP session.")
  }
  const key = `${identity.laneId}:${identity.paneId}`
  const existing = sessions.get(key)
  if (identity.mode === "attach") {
    return existing && !existing.exited && existing.harnessId === identity.harnessId && existing.generation === identity.generation ? existing : null
  }
  if (existing && !existing.exited && existing.harnessId === identity.harnessId && existing.generation === identity.generation) return existing
  if (existing) {
    clearReservation(existing)
    clearSessionTracking(existing)
    terminatePtyProcessTree(existing.pty)
    sessions.delete(key)
  }
  if (sessions.size >= MAX_SESSIONS) throw new Error(`Terminal limit reached (${MAX_SESSIONS}). Close an agent pane first.`)
  if (identity.resumeSessionId && [...sessions.values()].some((session) => !session.exited && session.resumeSessionId === identity.resumeSessionId)) {
    throw new Error("OMP session is already active in another pane.")
  }
  const cwd = laneDirectory(identity.laneId)
  const adapter = harnessAdapters[identity.harnessId]
  const identityEnabled = identity.harnessId === "omp"
    && process.env.OPERATOR_ENGINE_DISABLE_OMP_IDENTITY !== "1"
    && Boolean(identityExtension && fs.existsSync(identityExtension))
  const identityNonce = identityEnabled ? randomBytes(32).toString("base64url") : null
  const identityFile = identityEnabled ? path.join(identityDirectory, `${randomBytes(16).toString("hex")}.jsonl`) : null
  const resolved = adapter.command({
    cwd,
    systemPrompt: identity.mode === "start" ? identity.systemPrompt : undefined,
    resumeSessionId: identity.mode === "resume-exact" ? identity.resumeSessionId : undefined,
    resumePicker: identity.mode === "choose-omp-session",
    identityExtension: identityEnabled ? identityExtension : undefined,
  })
  const ptyEnv = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    [executablePathKey]: `${helperDirectory}${path.delimiter}${process.env[executablePathKey] ?? ""}`,
    OPERATOR_ENGINE_LANE_ID: identity.laneId,
    OPERATOR_ENGINE_PANE_ID: identity.paneId,
    OPERATOR_ENGINE_LANE_CONTEXT: path.join(dataDirectory, "lane-context", identity.laneId, "index.md"),
    OPERATOR_ENGINE_CONTROL_ORIGIN: controlOrigin,
    OPERATOR_ENGINE_CONTROL_URL: `${controlOrigin}/api/control/web-preview/open`,
    OPERATOR_ENGINE_CONTROL_TOKEN: identity.controlToken,
    OPERATOR_ENGINE_RUNTIME_ROLE: identity.runtimeIdentity.role,
    OPERATOR_ENGINE_RUNTIME_MODE: identity.runtimeIdentity.mode,
    OPERATOR_ENGINE_RUNTIME_DISTRIBUTION: identity.runtimeIdentity.distribution,
    OPERATOR_ENGINE_WEB_PORT: String(identity.runtimeIdentity.webPort),
    OPERATOR_ENGINE_TERMINAL_PORT: String(identity.runtimeIdentity.terminalPort),
    OPERATOR_ENGINE_DATA_CLASS: identity.runtimeIdentity.dataClass,
    ...(identity.runtimeIdentity.sourceCommit ? { OPERATOR_ENGINE_SOURCE_COMMIT: identity.runtimeIdentity.sourceCommit } : {}),
    ...(identity.runtimeIdentity.releaseId ? { OPERATOR_ENGINE_RELEASE_ID: identity.runtimeIdentity.releaseId } : {}),
    ...(identity.runtimeIdentity.contentSha256 ? { OPERATOR_ENGINE_CONTENT_SHA256: identity.runtimeIdentity.contentSha256 } : {}),
  }
  delete ptyEnv.OPERATOR_ENGINE_OMP_IDENTITY_FILE
  delete ptyEnv.OPERATOR_ENGINE_OMP_IDENTITY_NONCE
  delete ptyEnv.OPERATOR_ENGINE_ACCESS_PASSWORD
  delete ptyEnv.OPERATOR_ENGINE_ACCESS_SESSION_SECRET
  delete ptyEnv.OPERATOR_ENGINE_TERMINAL_SECRET
  if (identityFile && identityNonce) {
    ptyEnv.OPERATOR_ENGINE_OMP_IDENTITY_FILE = identityFile
    ptyEnv.OPERATOR_ENGINE_OMP_IDENTITY_NONCE = identityNonce
  }
  const startedAt = Date.now()
  const pty = nodePty.spawn(resolved.executable, resolved.args, {
    name: "xterm-256color",
    cols: 120,
    rows: 36,
    cwd,
    env: ptyEnv,
  })
  let session = null
  let startupBuffer = ""
  let startupExit = null
  const handleData = (data) => {
    if (!session) {
      startupBuffer = (startupBuffer + data).slice(-MAX_BUFFER)
      return
    }
    if (sessions.get(key) !== session || session.exited) return
    session.buffer = (session.buffer + data).slice(-MAX_BUFFER)
    broadcast(session, { kind: "output", generation: session.generation, data })
  }
  const handleExit = ({ exitCode }) => {
    if (!session) {
      startupExit = { exitCode }
      return
    }
    const abandonedReservation = session.reserved
    clearReservation(session)
    clearSessionTracking(session)
    session.exited = true
    if (!shuttingDown) {
      broadcast(session, { kind: "exit", generation: session.generation, message: `${session.label} exited with code ${exitCode}.` })
      for (const client of session.clients) client.close(1000, `${session.label} exited`)
    }
    if (sessions.get(key) === session) sessions.delete(key)
    if (abandonedReservation) {
      void serializeReservation(session.laneId, session.paneId, () =>
        settleReservedSession(session.laneId, session.paneId, session.generation)).catch(() => undefined)
    }
  }
  pty.onData(handleData)
  pty.onExit(handleExit)
  let startedBinding = binding
  try {
    if (identity.mode === "start" && identity.guidanceIncluded) {
      startedBinding = markGuidanceStarted(identity.laneId, identity.paneId, identity.generation)
    }
  } catch (error) {
    terminatePtyProcessTree(pty)
    if (identityFile) void fs.promises.rm(identityFile, { force: true }).catch(() => undefined)
    throw error
  }
  session = {
    key,
    laneId: identity.laneId,
    paneId: identity.paneId,
    generation: identity.generation,
    cwd,
    pty,
    clients: new Set(),
    buffer: startupBuffer,
    exited: false,
    harnessId: identity.harnessId,
    label: adapter.label,
    kickoffSent: startedBinding.kickoffSent,
    resumeSessionId: identity.mode === "resume-exact" ? identity.resumeSessionId : null,
    sessionFile: null,
    sessionTitle: null,
    startedAt,
    identityFile,
    identityNonce,
    identityObserved: identity.mode === "resume-exact",
    identityProcessedLines: 0,
    identityReading: false,
    identityReadFailed: false,
    identityWatchListener: null,
    identityFallbackTimer: null,
    identityFallbackReading: false,
    identityFallbackToken: 0,
    identityPersistedId: identity.mode === "resume-exact" ? identity.resumeSessionId : null,
    identityPersistAttempts: 0,
    identityPersistTimer: null,
    metadataReading: false,
    metadataWatchListener: null,
    metadataDebounceTimer: null,
    reserved: false,
    reservationExpiresAt: null,
    reservationTimer: null,
  }
  sessions.set(key, session)
  if (startupExit) {
    const { exitCode } = startupExit
    handleExit(startupExit)
    throw new Error(`${adapter.label} exited with code ${exitCode}.`)
  }
  if (identity.harnessId === "omp") startIdentityTracking(session, identity)
  return session
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ok: true, sessions: sessions.size }))
    return
  }
  if (request.url === "/harnesses") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    response.end(JSON.stringify({ harnesses: await detectHarnesses() }))
    return
  }
  if (request.method === "POST" && request.url === "/prewarm") {
    if (!loopback(request.socket.remoteAddress) || !authorized(request)) {
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Terminal relay authorization failed." }))
      return
    }
    let identity = null
    try {
      const body = await requestJson(request)
      identity = verifyTicket(body.ticket)
      if (!identity) throw new Error("Invalid or expired terminal ticket.")
      const session = await serializeReservation(identity.laneId, identity.paneId, () => reserveSession(identity, body.ttlMs))
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      response.end(JSON.stringify({ expiresAt: session.reservationExpiresAt }))
    } catch (error) {
      const current = identity ? sessions.get(`${identity.laneId}:${identity.paneId}`) : null
      const spawned = Boolean(identity && current && !current.exited && current.generation === identity.generation)
      response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" })
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Unable to prewarm OMP.",
        ...(spawned ? {} : { spawned: false }),
      }))
    }
    return
  }
  const prewarmRoute = new URL(request.url ?? "/", "http://localhost").pathname.match(
    /^\/prewarm\/([A-Za-z0-9_.-]{1,128})\/([A-Za-z0-9_.-]{1,128})\/([1-9][0-9]*)$/,
  )
  if ((request.method === "GET" || request.method === "DELETE") && prewarmRoute) {
    if (!loopback(request.socket.remoteAddress) || !authorized(request)) {
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Terminal relay authorization failed." }))
      return
    }
    const laneId = decodeURIComponent(prewarmRoute[1])
    const paneId = decodeURIComponent(prewarmRoute[2])
    const generation = Number(prewarmRoute[3])
    if (!ID_PATTERN.test(laneId) || !ID_PATTERN.test(paneId) || !Number.isSafeInteger(generation)) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid terminal reservation identity." }))
      return
    }
    try {
      const payload = request.method === "GET"
        ? { reserved: hasReservedSession(laneId, paneId, generation) }
        : await serializeReservation(laneId, paneId, async () => {
            const settlement = settleReservedSession(laneId, paneId, generation)
            return { cancelled: settlement.cancelled }
          })
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      response.end(JSON.stringify(payload))
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to settle OMP prewarm." }))
    }
    return
  }
  const paneSessionRoute = new URL(request.url ?? "/", "http://localhost").pathname.match(
    /^\/sessions\/([A-Za-z0-9_.-]{1,128})\/([A-Za-z0-9_.-]{1,128})\/([1-9][0-9]*)$/,
  )
  if (request.method === "DELETE" && paneSessionRoute) {
    if (!loopback(request.socket.remoteAddress)) {
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Loopback access required." }))
      return
    }
    if (!authorized(request)) {
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Terminal relay authorization failed." }))
      return
    }
    const laneId = decodeURIComponent(paneSessionRoute[1])
    const paneId = decodeURIComponent(paneSessionRoute[2])
    const deletedGeneration = Number(paneSessionRoute[3])
    if (!ID_PATTERN.test(laneId) || !ID_PATTERN.test(paneId) || !Number.isSafeInteger(deletedGeneration)) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid terminal identity." }))
      return
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    response.end(JSON.stringify({ terminated: terminatePaneSession(laneId, paneId, deletedGeneration) }))
    return
  }

  const sessionRoute = new URL(request.url ?? "/", "http://localhost").pathname.match(/^\/sessions\/([A-Za-z0-9_.-]{1,128})$/)
  if (request.method === "DELETE" && sessionRoute) {
    if (!loopback(request.socket.remoteAddress)) {
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Loopback access required." }))
      return
    }
    if (!authorized(request)) {
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Terminal relay authorization failed." }))
      return
    }
    const laneId = decodeURIComponent(sessionRoute[1])
    if (!ID_PATTERN.test(laneId)) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid lane identity." }))
      return
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    response.end(JSON.stringify({ terminated: terminateLaneSessions(laneId) }))
    return
  }
  response.writeHead(404).end()
})
const websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
  if (url.pathname !== "/terminal") return socket.destroy()
  const identity = verifyTicket(url.searchParams.get("ticket"))
  if (!identity) return socket.destroy()
  websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client, identity))
})

websocket.on("connection", async (client, identity) => {
  client.audience = identity.audience
  let session
  try { session = openSession(identity) } catch (error) {
    sendClientMessage(client, { kind: "error", generation: identity.generation, message: error instanceof Error ? error.message : "Unable to start terminal." })
    client.close(1011, "Terminal unavailable")
    return
  }
  if (!session) {
    sendClientMessage(client, { kind: "missing", generation: identity.generation })
    client.close(4404, "No active terminal session")
    return
  }
  if (identity.audience === "operator" && identity.mode === "attach" && session.reserved) {
    try {
      const settlement = await serializeReservation(session.laneId, session.paneId, () => settleReservedSession(session.laneId, session.paneId, session.generation))
      if (settlement.status !== "consumed") {
        sendClientMessage(client, { kind: "missing", generation: identity.generation })
        client.close(4404, "Terminal reservation was not durably inserted")
        return
      }
    } catch (error) {
      sendClientMessage(client, { kind: "error", generation: identity.generation, message: error instanceof Error ? error.message : "Unable to consume terminal reservation." })
      client.close(1011, "Terminal reservation unavailable")
      return
    }
  }
  if (identity.mode === "attach" && session.resumeSessionId) scheduleIdentityPersistence(session, true)
  session.clients.add(client)
  const binding = getTerminalBinding(continuityDb, session.laneId, session.paneId)
  if (binding?.generation === session.generation) {
    const { laneId: _laneId, ...publicBinding } = binding
    sendClientMessage(client, { kind: "binding", generation: session.generation, binding: publicBinding })
  }
  sendClientMessage(client, { kind: "started", generation: session.generation, kickoffSent: session.kickoffSent })
  if (session.sessionTitle) {
    sendClientMessage(client, { kind: "session", generation: session.generation, title: session.sessionTitle })
  }
  sendClientMessage(client, { kind: "status", generation: session.generation, message: `${session.label} attached in ${session.cwd}` })
  if (session.buffer) {
    sendClientMessage(client, { kind: "output", generation: session.generation, data: session.buffer })
  }
  client.on("message", (raw) => {
    try {
      if (sessions.get(session.key) !== session || session.exited) {
        client.close(4409, "Terminal generation replaced")
        return
      }
      const result = handleInboundFrame(client.audience, raw, {
        onInput: (data) => {
          session.pty.write(data)
          scheduleIdentityFallback(session, IDENTITY_INPUT_FALLBACK_DELAY_MS, true)
        },
        onResize: (cols, rows) => {
          session.pty.resize(cols, rows)
        },
      })
      if (!result.ok && !result.blocked) {
        sendClientMessage(client, { kind: "error", generation: session.generation, message: "Invalid terminal frame." })
      }
    } catch {
      sendClientMessage(client, { kind: "error", generation: session.generation, message: "Invalid terminal frame." })
    }
  })
  client.on("close", () => session.clients.delete(client))
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const session of sessions.values()) {
    clearSessionTracking(session)
    terminatePtyProcessTree(session.pty)
  }
  continuityDb.close()
  fs.rmSync(identityDirectory, { recursive: true, force: true })
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
server.listen(port, host, () => process.stdout.write(`Operator Engine terminal relay listening on ${host}:${port}\n`))
