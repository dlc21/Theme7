import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  signTerminalControlCapability,
  validateTerminalIdentity,
  verifyTerminalControlCapability,
} from "./terminal-control-capability.mjs"

const env = { NODE_ENV: "test", OPERATOR_ENGINE_TERMINAL_SECRET: "fixture-test-secret" }

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = createHmac("sha256", env.OPERATOR_ENGINE_TERMINAL_SECRET).update(body).digest("base64url")
  return `${body}.${signature}`
}

describe("bare-Node terminal control capabilities", () => {
  afterEach(() => vi.useRealTimers())

  it("authorizes both scoped terminal actions with the established expiry bounds", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const token = signTerminalControlCapability({ laneId: "lane-1", paneId: "terminal.2", generation: 3 }, env)

    expect(verifyTerminalControlCapability(token, "open_web_preview", env)).toEqual({
      laneId: "lane-1",
      paneId: "terminal.2",
      generation: 3,
      actions: ["open_web_preview", "close_terminal"],
      expiresAt: Date.now() + 43_200_000,
    })
    expect(verifyTerminalControlCapability(token, "close_terminal", env)).toMatchObject({ laneId: "lane-1", paneId: "terminal.2" })

    const minimum = signTerminalControlCapability({ laneId: "lane-1", paneId: "terminal.2", generation: 3, ttlMs: 1 }, env)
    expect(verifyTerminalControlCapability(minimum, "close_terminal", env)?.expiresAt).toBe(Date.now() + 60_000)
    const maximum = signTerminalControlCapability({ laneId: "lane-1", paneId: "terminal.2", generation: 3, ttlMs: Number.MAX_SAFE_INTEGER }, env)
    expect(verifyTerminalControlCapability(maximum, "close_terminal", env)?.expiresAt).toBe(Date.now() + 86_400_000)
  })

  it("rejects invalid identities, signatures, and expired capabilities", () => {
    expect(() => validateTerminalIdentity("../lane", "terminal.2")).toThrow("Invalid terminal identity.")
    expect(() => signTerminalControlCapability({ laneId: "lane-1", paneId: "terminal/2", generation: 3 }, env)).toThrow("Invalid terminal identity.")
    expect(() => signTerminalControlCapability({ laneId: "lane-1", paneId: "terminal.2", generation: 0 }, env)).toThrow("Invalid terminal binding generation.")

    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const token = signTerminalControlCapability({ laneId: "lane-1", paneId: "terminal.2", generation: 3, ttlMs: 60_000 }, env)
    expect(verifyTerminalControlCapability(`${token}x`, "close_terminal", env)).toBeNull()
    vi.advanceTimersByTime(60_001)
    expect(verifyTerminalControlCapability(token, "close_terminal", env)).toBeNull()
  })

  it.each([
    ["non-array actions", "open_web_preview", { actions: "open_web_preview" }],
    ["empty actions", "open_web_preview", { actions: [] }],
    ["duplicate actions", "open_web_preview", { actions: ["open_web_preview", "open_web_preview"] }],
    ["unknown actions", "open_web_preview", { actions: ["open_web_preview", "delete_lane"] }],
    ["missing required action", "close_terminal", { actions: ["open_web_preview"] }],
    ["invalid identity", "open_web_preview", { laneId: "../lane", actions: ["open_web_preview"] }],
    ["missing generation", "open_web_preview", { generation: undefined }],
    ["invalid generation", "open_web_preview", { generation: 0 }],
  ])("rejects %s", (_name, requiredAction, override) => {
    const token = signPayload({
      laneId: "lane-1",
      paneId: "terminal.2",
      generation: 3,
      actions: ["open_web_preview", "close_terminal"],
      expiresAt: Date.now() + 60_000,
      ...override,
    })
    expect(verifyTerminalControlCapability(token, requiredAction, env)).toBeNull()
  })

  it("allows a valid action subset only for the action it contains", () => {
    const token = signPayload({ laneId: "lane-1", paneId: "terminal.2", generation: 3, actions: ["open_web_preview"], expiresAt: Date.now() + 60_000 })
    expect(verifyTerminalControlCapability(token, "open_web_preview", env)).toMatchObject({ actions: ["open_web_preview"] })
    expect(verifyTerminalControlCapability(token, "close_terminal", env)).toBeNull()
    expect(verifyTerminalControlCapability(token, "delete_lane", env)).toBeNull()
  })
})
