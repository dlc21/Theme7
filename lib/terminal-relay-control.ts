import { terminalLoopbackOrigin } from "../scripts/runtime-config-core.mjs"
import { terminalSecret } from "../scripts/runtime-config-core.mjs"
import { validateTerminalIdentity } from "@/lib/terminal-ticket"

export async function terminateLaneTerminalSessions(laneId: string): Promise<number> {
  validateTerminalIdentity(laneId, "lane-cleanup")
  const response = await fetch(`${terminalLoopbackOrigin()}/sessions/${encodeURIComponent(laneId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${terminalSecret()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(2_000),
  })
  const payload = await response.json().catch(() => ({})) as { terminated?: number; error?: string }
  if (!response.ok) throw new Error(payload.error || `Terminal relay cleanup failed (${response.status}).`)
  return Number.isInteger(payload.terminated) ? payload.terminated! : 0
}

export async function terminateTerminalSession(laneId: string, paneId: string, deletedGeneration: number): Promise<number> {
  validateTerminalIdentity(laneId, paneId)
  if (!Number.isSafeInteger(deletedGeneration) || deletedGeneration < 1) throw new Error("Invalid terminal binding generation.")
  const response = await fetch(
    `${terminalLoopbackOrigin()}/sessions/${encodeURIComponent(laneId)}/${encodeURIComponent(paneId)}/${deletedGeneration}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${terminalSecret()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    },
  )
  const payload = await response.json().catch(() => ({})) as { terminated?: number; error?: string }
  if (!response.ok) throw new Error(payload.error || `Terminal relay cleanup failed (${response.status}).`)
  return payload.terminated === 1 ? 1 : 0
}

export class TerminalPrewarmRelayError extends Error {
  readonly spawned: boolean | null

  constructor(message: string, spawned: boolean | null) {
    super(message)
    this.name = "TerminalPrewarmRelayError"
    this.spawned = spawned
  }
}

export async function prewarmOmpTerminal(ticket: string, ttlMs: number): Promise<number> {
  const response = await fetch(`${terminalLoopbackOrigin()}/prewarm`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalSecret()}`, "content-type": "application/json" },
    body: JSON.stringify({ ticket, ttlMs }),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  })
  const payload = await response.json().catch(() => ({})) as { expiresAt?: number; spawned?: boolean; error?: string }
  if (!response.ok) {
    throw new TerminalPrewarmRelayError(payload.error || `OMP prewarm failed (${response.status}).`, payload.spawned === false ? false : null)
  }
  if (!Number.isFinite(payload.expiresAt)) throw new TerminalPrewarmRelayError("OMP prewarm returned an invalid expiry.", null)
  return payload.expiresAt!
}

export async function cancelPrewarmedOmpTerminal(laneId: string, paneId: string, expectedGeneration: number): Promise<boolean> {
  validateTerminalIdentity(laneId, paneId)
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw new Error("Invalid terminal binding generation.")
  const response = await fetch(`${terminalLoopbackOrigin()}/prewarm/${encodeURIComponent(laneId)}/${encodeURIComponent(paneId)}/${expectedGeneration}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${terminalSecret()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(2_000),
  })
  const payload = await response.json().catch(() => ({})) as { cancelled?: boolean; error?: string }
  if (!response.ok) throw new Error(payload.error || `OMP prewarm cleanup failed (${response.status}).`)
  return payload.cancelled === true
}

export async function hasPrewarmedOmpTerminal(laneId: string, paneId: string, generation: number): Promise<boolean> {
  validateTerminalIdentity(laneId, paneId)
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid terminal binding generation.")
  const response = await fetch(`${terminalLoopbackOrigin()}/prewarm/${encodeURIComponent(laneId)}/${encodeURIComponent(paneId)}/${generation}`, {
    headers: { authorization: `Bearer ${terminalSecret()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(2_000),
  })
  const payload = await response.json().catch(() => ({})) as { reserved?: boolean; error?: string }
  if (!response.ok) throw new Error(payload.error || `OMP prewarm lookup failed (${response.status}).`)
  return payload.reserved === true
}
