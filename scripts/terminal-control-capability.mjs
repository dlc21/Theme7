import { createHmac, timingSafeEqual } from "node:crypto"

import { terminalSecret } from "./runtime-config-core.mjs"
import { isValidClientIdentityPart } from "./layout-tree-policy.mjs"

const TERMINAL_CONTROL_ACTIONS = ["open_web_preview", "close_terminal"]
const TERMINAL_CONTROL_ACTION_SET = Object.fromEntries(TERMINAL_CONTROL_ACTIONS.map((action) => [action, true]))
const MIN_TTL_MS = 60_000
const DEFAULT_TTL_MS = 43_200_000
const MAX_TTL_MS = 86_400_000

export function validateTerminalIdentity(laneId, paneId) {
  if (!isValidClientIdentityPart(laneId) || !isValidClientIdentityPart(paneId)) {
    throw new Error("Invalid terminal identity.")
  }
}

function signPayload(payload, env) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = createHmac("sha256", terminalSecret(env)).update(body).digest("base64url")
  return `${body}.${signature}`
}

function verifyPayload(token, env) {
  if (typeof token !== "string") return null
  const [body, signature, extra] = token.split(".")
  if (!body || !signature || extra) return null
  const expected = createHmac("sha256", terminalSecret(env)).update(body).digest()
  let received
  try { received = Buffer.from(signature, "base64url") } catch { return null }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) } catch { return null }
}

export function signTerminalControlCapability(input, env = process.env) {
  validateTerminalIdentity(input.laneId, input.paneId)
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("Invalid terminal binding generation.")
  const ttlMs = Number.isFinite(input.ttlMs) ? input.ttlMs : DEFAULT_TTL_MS
  return signPayload({
    laneId: input.laneId,
    paneId: input.paneId,
    generation: input.generation,
    actions: [...TERMINAL_CONTROL_ACTIONS],
    expiresAt: Date.now() + Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs)),
  }, env)
}

export function verifyTerminalControlCapability(token, requiredAction, env = process.env) {
  if (!TERMINAL_CONTROL_ACTION_SET[requiredAction]) return null
  const payload = verifyPayload(token, env)
  if (!payload || typeof payload !== "object") return null
  try { validateTerminalIdentity(payload.laneId, payload.paneId) } catch { return null }
  if (!Number.isSafeInteger(payload.generation) || payload.generation < 1) return null
  if (!Array.isArray(payload.actions) || payload.actions.length === 0) return null
  const seen = new Set()
  for (const action of payload.actions) {
    if (!TERMINAL_CONTROL_ACTION_SET[action] || seen.has(action)) return null
    seen.add(action)
  }
  if (!seen.has(requiredAction) || !Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now()) return null
  return payload
}
