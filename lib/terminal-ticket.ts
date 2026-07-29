import { createHmac, timingSafeEqual } from "node:crypto"

import { terminalSecret } from "../scripts/runtime-config-core.mjs"
import {
  signTerminalControlCapability,
  validateTerminalIdentity,
  verifyTerminalControlCapability,
} from "../scripts/terminal-control-capability.mjs"
import type { TerminalControlAction, TerminalControlCapability } from "../scripts/terminal-control-capability.mjs"
import { assertRuntimeIdentity } from "../scripts/runtime-identity-policy.mjs"
import type { RuntimeIdentityPublic } from "@/lib/distributions"
import type { HarnessId } from "@/lib/types"

export { terminalSecret }
export { signTerminalControlCapability, validateTerminalIdentity, verifyTerminalControlCapability }
export type { TerminalControlAction, TerminalControlCapability }

export type TerminalTicketMode = "attach" | "start" | "resume-exact" | "choose-omp-session"

export type TerminalAudience = "operator" | "spectator"

export type OperatorTerminalTicket = {
  audience: "operator"
  laneId: string
  paneId: string
  harnessId: HarnessId
  generation: number
  mode: TerminalTicketMode
  runtimeIdentity: RuntimeIdentityPublic
  systemPrompt?: string
  resumeSessionId?: string
  guidanceIncluded?: boolean
  controlToken: string
  expiresAt: number
}

export type SpectatorTerminalTicket = {
  audience: "spectator"
  laneId: string
  paneId: string
  harnessId: HarnessId
  generation: number
  mode: "attach"
  runtimeIdentity: RuntimeIdentityPublic
  expiresAt: number
}

export type TerminalTicket = OperatorTerminalTicket | SpectatorTerminalTicket

const MAX_PROMPT = 32_000
const EXACT_OMP_SESSION_PATTERN = /^[A-Za-z0-9._:-]{6,240}$/

function validateHarness(value: unknown): asserts value is HarnessId {
  if (value !== "omp" && value !== "codex" && value !== "shell") throw new Error("Invalid terminal harness.")
}

function validateModeFields(ticket: OperatorTerminalTicket): boolean {
  if (ticket.mode === "attach") {
    return ticket.systemPrompt === undefined && ticket.resumeSessionId === undefined && ticket.guidanceIncluded === undefined
  }
  if (ticket.mode === "start") {
    return ticket.resumeSessionId === undefined
      && (ticket.systemPrompt === undefined || (typeof ticket.systemPrompt === "string" && ticket.systemPrompt.length <= MAX_PROMPT))
      && (ticket.guidanceIncluded === undefined || typeof ticket.guidanceIncluded === "boolean")
  }
  if (ticket.mode === "resume-exact") {
    return ticket.harnessId === "omp"
      && typeof ticket.resumeSessionId === "string"
      && EXACT_OMP_SESSION_PATTERN.test(ticket.resumeSessionId)
      && ticket.systemPrompt === undefined
      && ticket.guidanceIncluded === undefined
  }
  if (ticket.mode === "choose-omp-session") {
    return ticket.harnessId === "omp"
      && ticket.resumeSessionId === undefined
      && ticket.systemPrompt === undefined
      && ticket.guidanceIncluded === undefined
  }
  return false
}

function signPayload(payload: object, env: NodeJS.ProcessEnv): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = createHmac("sha256", terminalSecret(env)).update(body).digest("base64url")
  return `${body}.${signature}`
}

function verifyPayload<T>(token: string, env: NodeJS.ProcessEnv): T | null {
  const [body, signature, extra] = token.split(".")
  if (!body || !signature || extra) return null
  const expected = createHmac("sha256", terminalSecret(env)).update(body).digest()
  let received: Buffer
  try { received = Buffer.from(signature, "base64url") } catch { return null }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T } catch { return null }
}

export function signTerminalTicket(
  input: {
    laneId: string
    paneId: string
    harnessId: HarnessId
    generation: number
    mode: TerminalTicketMode
    runtimeIdentity: RuntimeIdentityPublic
    systemPrompt?: string
    resumeSessionId?: string
    guidanceIncluded?: boolean
    ttlMs?: number
    audience?: "operator"
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (input.audience !== undefined && input.audience !== "operator") {
    throw new Error("signTerminalTicket only signs operator audience tickets.")
  }
  validateTerminalIdentity(input.laneId, input.paneId)
  validateHarness(input.harnessId)
  assertRuntimeIdentity(input.runtimeIdentity)
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("Invalid terminal binding generation.")
  const payload: OperatorTerminalTicket = {
    audience: "operator",
    laneId: input.laneId,
    paneId: input.paneId,
    harnessId: input.harnessId,
    generation: input.generation,
    mode: input.mode,
    runtimeIdentity: input.runtimeIdentity,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    ...(input.guidanceIncluded ? { guidanceIncluded: true } : {}),
    controlToken: signTerminalControlCapability({
      laneId: input.laneId,
      paneId: input.paneId,
      generation: input.generation,
    }, env),
    expiresAt: Date.now() + Math.min(120_000, Math.max(5_000, input.ttlMs ?? 30_000)),
  }
  if (!validateModeFields(payload)) throw new Error("Invalid terminal ticket mode.")
  return signPayload(payload, env)
}

export function signSpectatorTerminalTicket(
  input: {
    laneId: string
    paneId: string
    harnessId: HarnessId
    generation: number
    mode?: "attach"
    runtimeIdentity: RuntimeIdentityPublic
    ttlMs?: number
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const rawInput = input as Record<string, unknown>
  if (
    rawInput.systemPrompt !== undefined
    || rawInput.resumeSessionId !== undefined
    || rawInput.guidanceIncluded !== undefined
    || rawInput.controlToken !== undefined
  ) {
    throw new Error("Spectator tickets cannot carry prompt, session, guidance, or control capabilities.")
  }
  if (input.mode !== undefined && input.mode !== "attach") {
    throw new Error("Spectator tickets permit attach mode only.")
  }
  validateTerminalIdentity(input.laneId, input.paneId)
  validateHarness(input.harnessId)
  assertRuntimeIdentity(input.runtimeIdentity)
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("Invalid terminal binding generation.")

  const payload: SpectatorTerminalTicket = {
    audience: "spectator",
    laneId: input.laneId,
    paneId: input.paneId,
    harnessId: input.harnessId,
    generation: input.generation,
    mode: "attach",
    runtimeIdentity: input.runtimeIdentity,
    expiresAt: Date.now() + Math.min(120_000, Math.max(5_000, input.ttlMs ?? 30_000)),
  }
  return signPayload(payload, env)
}

export function verifyTerminalTicket(token: string, env: NodeJS.ProcessEnv = process.env): TerminalTicket | null {
  const payload = verifyPayload<Record<string, unknown>>(token, env)
  if (!payload || typeof payload !== "object") return null
  try {
    if (payload.audience === "operator") {
      const ticket = payload as unknown as OperatorTerminalTicket
      validateTerminalIdentity(ticket.laneId, ticket.paneId)
      validateHarness(ticket.harnessId)
      assertRuntimeIdentity(ticket.runtimeIdentity)
      if (!Number.isSafeInteger(ticket.generation) || ticket.generation < 1 || !validateModeFields(ticket)) return null
      if (typeof ticket.controlToken !== "string") return null
      const previewControl = verifyTerminalControlCapability(ticket.controlToken, "open_web_preview", env)
      const closeControl = verifyTerminalControlCapability(ticket.controlToken, "close_terminal", env)
      if (!previewControl || !closeControl) return null
      if (previewControl.laneId !== ticket.laneId || previewControl.paneId !== ticket.paneId || previewControl.generation !== ticket.generation) return null
      if (closeControl.laneId !== ticket.laneId || closeControl.paneId !== ticket.paneId || closeControl.generation !== ticket.generation) return null
      if (!Number.isFinite(ticket.expiresAt) || ticket.expiresAt < Date.now()) return null
      return ticket
    }

    if (payload.audience === "spectator") {
      if ("controlToken" in payload && payload.controlToken !== undefined) return null
      if (payload.mode !== "attach") return null
      if (payload.systemPrompt !== undefined || payload.resumeSessionId !== undefined || payload.guidanceIncluded !== undefined) return null
      const ticket = payload as unknown as SpectatorTerminalTicket
      validateTerminalIdentity(ticket.laneId, ticket.paneId)
      validateHarness(ticket.harnessId)
      assertRuntimeIdentity(ticket.runtimeIdentity)
      if (!Number.isSafeInteger(ticket.generation) || ticket.generation < 1) return null
      if (!Number.isFinite(ticket.expiresAt) || ticket.expiresAt < Date.now()) return null
      return ticket
    }

    return null
  } catch { return null }
}
