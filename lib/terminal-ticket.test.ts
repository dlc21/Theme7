import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  signSpectatorTerminalTicket,
  signTerminalControlCapability,
  signTerminalTicket,
  verifyTerminalControlCapability,
  verifyTerminalTicket,
} from "@/lib/terminal-ticket"

const env = { NODE_ENV: "test", OPERATOR_ENGINE_TERMINAL_SECRET: "fixture-test-secret" } satisfies NodeJS.ProcessEnv
const runtimeIdentity = { sourceCommit: null, distribution: "stock", role: "development", mode: "hmr", webPort: 4400, terminalPort: 4401, dataClass: "isolated", releaseId: null, contentSha256: null } as const

function signPayload(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = createHmac("sha256", "fixture-test-secret").update(body).digest("base64url")
  return `${body}.${signature}`
}

describe("terminal tickets", () => {
  afterEach(() => vi.useRealTimers())

  it("round-trips the four generation-bound launch modes", () => {
    const attach = verifyTerminalTicket(signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 3, mode: "attach", runtimeIdentity,
    }, env), env)
    expect(attach).toMatchObject({ audience: "operator", harnessId: "shell", generation: 3, mode: "attach" })
    expect(attach).toHaveProperty("controlToken")

    const start = verifyTerminalTicket(signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "codex", generation: 4, mode: "start",
      systemPrompt: "server prompt", guidanceIncluded: true, runtimeIdentity,
    }, env), env)
    expect(start).toMatchObject({ harnessId: "codex", generation: 4, mode: "start", systemPrompt: "server prompt", guidanceIncluded: true })

    const exact = verifyTerminalTicket(signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "omp", generation: 5, mode: "resume-exact",
      resumeSessionId: "session-123", runtimeIdentity,
    }, env), env)
    expect(exact).toMatchObject({ harnessId: "omp", generation: 5, mode: "resume-exact", resumeSessionId: "session-123" })

    const picker = verifyTerminalTicket(signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "omp", generation: 6, mode: "choose-omp-session", runtimeIdentity,
    }, env), env)
    expect(picker).toMatchObject({ harnessId: "omp", generation: 6, mode: "choose-omp-session" })
  })

  it("rejects fields outside each signed mode", () => {
    expect(() => signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 1, mode: "attach",
      systemPrompt: "not allowed", runtimeIdentity,
    }, env)).toThrow("Invalid terminal ticket mode.")
    expect(() => signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "omp", generation: 1, mode: "start",
      resumeSessionId: "session-123", runtimeIdentity,
    }, env)).toThrow("Invalid terminal ticket mode.")
    expect(() => signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 1, mode: "resume-exact",
      resumeSessionId: "session-123", runtimeIdentity,
    }, env)).toThrow("Invalid terminal ticket mode.")
    expect(() => signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "omp", generation: 1, mode: "choose-omp-session",
      guidanceIncluded: true, runtimeIdentity,
    }, env)).toThrow("Invalid terminal ticket mode.")
  })

  it("rejects tampering, expiry, and invalid identities", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const token = signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 2, mode: "start",
      ttlMs: 5_000, runtimeIdentity,
    }, env)
    expect(verifyTerminalTicket(`${token}x`, env)).toBeNull()
    vi.advanceTimersByTime(5_001)
    expect(verifyTerminalTicket(token, env)).toBeNull()
    expect(() => signTerminalTicket({
      laneId: "../escape", paneId: "terminal.2", harnessId: "shell", generation: 1, mode: "start", runtimeIdentity,
    }, env)).toThrow("Invalid")
  })

  it("binds terminal control to lane, pane, generation, actions, and expiry", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const token = signTerminalControlCapability({ laneId: "lane-1", paneId: "terminal.2", generation: 7, ttlMs: 60_000 }, env)
    expect(verifyTerminalControlCapability(token, "open_web_preview", env)).toMatchObject({
      laneId: "lane-1",
      paneId: "terminal.2",
      generation: 7,
      actions: ["open_web_preview", "close_terminal"],
    })
    expect(verifyTerminalControlCapability(token, "close_terminal", env)).toMatchObject({ generation: 7 })
    vi.advanceTimersByTime(60_001)
    expect(verifyTerminalControlCapability(token, "open_web_preview", env)).toBeNull()
  })

  it("rejects nested control identity, generation, and action mismatches", () => {
    const token = signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 7, mode: "start", runtimeIdentity,
    }, env)
    const [body] = token.split(".")
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))

    payload.controlToken = signTerminalControlCapability({ laneId: "lane-2", paneId: "terminal.2", generation: 7 }, env)
    expect(verifyTerminalTicket(signPayload(payload), env)).toBeNull()

    payload.controlToken = signTerminalControlCapability({ laneId: "lane-1", paneId: "terminal.2", generation: 8 }, env)
    expect(verifyTerminalTicket(signPayload(payload), env)).toBeNull()

    payload.controlToken = signPayload({
      laneId: "lane-1",
      paneId: "terminal.2",
      generation: 7,
      actions: ["open_web_preview"],
      expiresAt: Date.now() + 60_000,
    })
    expect(verifyTerminalTicket(signPayload(payload), env)).toBeNull()
  })

  it("round-trips spectator tickets with attach mode and no control token", () => {
    const token = signSpectatorTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 3, mode: "attach", runtimeIdentity,
    }, env)
    const spectator = verifyTerminalTicket(token, env)
    expect(spectator).toMatchObject({
      audience: "spectator",
      laneId: "lane-1",
      paneId: "terminal.2",
      harnessId: "shell",
      generation: 3,
      mode: "attach",
    })
    expect(spectator).not.toHaveProperty("controlToken")
  })

  it("rejects spectator tickets carrying control token, non-attach mode, or guidance/prompts", () => {
    // Spectator ticket with injected controlToken
    const validSpectatorToken = signSpectatorTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 3, runtimeIdentity,
    }, env)
    const [body] = validSpectatorToken.split(".")
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))

    payload.controlToken = signTerminalControlCapability({ laneId: "lane-1", paneId: "terminal.2", generation: 3 }, env)
    expect(verifyTerminalTicket(signPayload(payload), env)).toBeNull()

    // Spectator ticket with mode: start
    delete payload.controlToken
    payload.mode = "start"
    expect(verifyTerminalTicket(signPayload(payload), env)).toBeNull()

    // Spectator ticket with systemPrompt
    payload.mode = "attach"
    payload.systemPrompt = "malicious prompt"
    expect(verifyTerminalTicket(signPayload(payload), env)).toBeNull()
  })

  it("rejects operator tickets missing controlToken or having invalid audience", () => {
    const token = signTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 3, mode: "attach", runtimeIdentity,
    }, env)
    const [body] = token.split(".")
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))

    delete payload.controlToken
    expect(verifyTerminalTicket(signPayload(payload), env)).toBeNull()

    payload.audience = "invalid-audience"
    expect(verifyTerminalTicket(signPayload(payload), env)).toBeNull()
  })

  it("throws when signing spectator tickets with illegal capabilities or modes", () => {
    expect(() => signSpectatorTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 3, mode: "start" as unknown as "attach", runtimeIdentity,
    }, env)).toThrow("Spectator tickets permit attach mode only.")

    expect(() => signSpectatorTerminalTicket({
      laneId: "lane-1", paneId: "terminal.2", harnessId: "shell", generation: 3, systemPrompt: "forbidden", runtimeIdentity,
    } as unknown as Parameters<typeof signSpectatorTerminalTicket>[0], env)).toThrow("Spectator tickets cannot carry prompt, session, guidance, or control capabilities.")
  })
})
