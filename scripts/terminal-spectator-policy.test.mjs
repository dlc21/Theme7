import { describe, expect, it, vi } from "vitest"
import {
  handleInboundFrame,
  isAllowedOutboundFrame,
  isSpectatorAudience,
  sanitizeOutboundMessage,
} from "./terminal-spectator-policy.mjs"

describe("terminal spectator policy", () => {
  describe("isSpectatorAudience", () => {
    it("identifies spectator audience correctly", () => {
      expect(isSpectatorAudience("spectator")).toBe(true)
      expect(isSpectatorAudience("operator")).toBe(false)
      expect(isSpectatorAudience(undefined)).toBe(false)
      expect(isSpectatorAudience(null)).toBe(false)
    })
  })

  describe("handleInboundFrame for spectator audience", () => {
    it("blocks spectator input frames without calling onInput or onResize", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = JSON.stringify({ kind: "input", data: "ls -la\n" })

      const result = handleInboundFrame("spectator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: false, blocked: true, reason: "Spectator inbound frames strictly disabled." })
      expect(onInput).not.toHaveBeenCalled()
      expect(onResize).not.toHaveBeenCalled()
    })

    it("blocks spectator resize frames without calling onInput or onResize", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = JSON.stringify({ kind: "resize", cols: 100, rows: 30 })

      const result = handleInboundFrame("spectator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: false, blocked: true, reason: "Spectator inbound frames strictly disabled." })
      expect(onInput).not.toHaveBeenCalled()
      expect(onResize).not.toHaveBeenCalled()
    })

    it("blocks spectator malformed frames without parsing or calling callbacks", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = "{ invalid json"

      const result = handleInboundFrame("spectator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: false, blocked: true, reason: "Spectator inbound frames strictly disabled." })
      expect(onInput).not.toHaveBeenCalled()
      expect(onResize).not.toHaveBeenCalled()
    })

    it("blocks spectator custom frames without calling callbacks", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = JSON.stringify({ kind: "custom", payload: "test" })

      const result = handleInboundFrame("spectator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: false, blocked: true, reason: "Spectator inbound frames strictly disabled." })
      expect(onInput).not.toHaveBeenCalled()
      expect(onResize).not.toHaveBeenCalled()
    })

    it("supports object options signature for spectator", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = JSON.stringify({ kind: "input", data: "whoami\n" })

      const result = handleInboundFrame({ audience: "spectator", raw, onInput, onResize })

      expect(result.blocked).toBe(true)
      expect(onInput).not.toHaveBeenCalled()
      expect(onResize).not.toHaveBeenCalled()
    })
  })

  describe("handleInboundFrame for operator audience", () => {
    it("dispatches valid input frames to onInput", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = JSON.stringify({ kind: "input", data: "pwd\n" })

      const result = handleInboundFrame("operator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: true, kind: "input", data: "pwd\n" })
      expect(onInput).toHaveBeenCalledWith("pwd\n")
      expect(onResize).not.toHaveBeenCalled()
    })

    it("dispatches valid resize frames to onResize", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = JSON.stringify({ kind: "resize", cols: 120, rows: 40 })

      const result = handleInboundFrame("operator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: true, kind: "resize", cols: 120, rows: 40 })
      expect(onResize).toHaveBeenCalledWith(120, 40)
      expect(onInput).not.toHaveBeenCalled()
    })

    it("enforces lower bounds for resize dimensions", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = JSON.stringify({ kind: "resize", cols: 10, rows: 2 })

      const result = handleInboundFrame("operator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: true, kind: "resize", cols: 40, rows: 10 })
      expect(onResize).toHaveBeenCalledWith(40, 10)
    })

    it("enforces upper bounds for resize dimensions", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = JSON.stringify({ kind: "resize", cols: 1000, rows: 500 })

      const result = handleInboundFrame("operator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: true, kind: "resize", cols: 400, rows: 150 })
      expect(onResize).toHaveBeenCalledWith(400, 150)
    })

    it("returns error result for malformed JSON frames", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = "{ malformed json"

      const result = handleInboundFrame("operator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: false, blocked: false, error: "Invalid terminal frame." })
      expect(onInput).not.toHaveBeenCalled()
      expect(onResize).not.toHaveBeenCalled()
    })

    it("returns error result for unknown frame kinds", () => {
      const onInput = vi.fn()
      const onResize = vi.fn()
      const raw = JSON.stringify({ kind: "ping" })

      const result = handleInboundFrame("operator", raw, { onInput, onResize })

      expect(result).toEqual({ ok: false, blocked: false, error: "Invalid terminal frame." })
      expect(onInput).not.toHaveBeenCalled()
      expect(onResize).not.toHaveBeenCalled()
    })
  })

  describe("isAllowedOutboundFrame", () => {
    it("restricts spectator outbound frames to essential kinds", () => {
      expect(isAllowedOutboundFrame("spectator", "output")).toBe(true)
      expect(isAllowedOutboundFrame("spectator", "started")).toBe(true)
      expect(isAllowedOutboundFrame("spectator", "exit")).toBe(true)
      expect(isAllowedOutboundFrame("spectator", "error")).toBe(true)
      expect(isAllowedOutboundFrame("spectator", "missing")).toBe(true)

      expect(isAllowedOutboundFrame("spectator", "binding")).toBe(false)
      expect(isAllowedOutboundFrame("spectator", "session")).toBe(false)
      expect(isAllowedOutboundFrame("spectator", "status")).toBe(false)
      expect(isAllowedOutboundFrame("spectator", "custom")).toBe(false)
    })

    it("allows all outbound frame kinds for operator audience", () => {
      expect(isAllowedOutboundFrame("operator", "output")).toBe(true)
      expect(isAllowedOutboundFrame("operator", "started")).toBe(true)
      expect(isAllowedOutboundFrame("operator", "exit")).toBe(true)
      expect(isAllowedOutboundFrame("operator", "error")).toBe(true)
      expect(isAllowedOutboundFrame("operator", "missing")).toBe(true)
      expect(isAllowedOutboundFrame("operator", "binding")).toBe(true)
      expect(isAllowedOutboundFrame("operator", "session")).toBe(true)
      expect(isAllowedOutboundFrame("operator", "status")).toBe(true)
    })
  })

  describe("sanitizeOutboundMessage", () => {
    it("sanitizes spectator error frames to generic message with no metadata", () => {
      const sensitiveError = {
        kind: "error",
        generation: 3,
        message: "Duplicate binding for session-123 in /var/data/lane-1/pane-2",
      }

      const result = sanitizeOutboundMessage("spectator", sensitiveError)

      expect(result).toEqual({
        kind: "error",
        generation: 3,
        message: "Terminal error.",
      })
    })

    it("returns null for spectator disallowed outbound message kinds", () => {
      const bindingMsg = { kind: "binding", generation: 3, binding: { id: "b1" } }
      const sessionMsg = { kind: "session", generation: 3, title: "Secret Session" }
      const statusMsg = { kind: "status", generation: 3, message: "attached in /secret/path" }

      expect(sanitizeOutboundMessage("spectator", bindingMsg)).toBeNull()
      expect(sanitizeOutboundMessage("spectator", sessionMsg)).toBeNull()
      expect(sanitizeOutboundMessage("spectator", statusMsg)).toBeNull()
    })

    it("preserves spectator allowed non-error outbound message kinds", () => {
      const outputMsg = { kind: "output", generation: 3, data: "hello" }
      const startedMsg = { kind: "started", generation: 3, kickoffSent: true }
      const exitMsg = { kind: "exit", generation: 3, message: "exited with code 0" }
      const missingMsg = { kind: "missing", generation: 3 }

      expect(sanitizeOutboundMessage("spectator", outputMsg)).toEqual(outputMsg)
      expect(sanitizeOutboundMessage("spectator", startedMsg)).toEqual(startedMsg)
      expect(sanitizeOutboundMessage("spectator", exitMsg)).toEqual(exitMsg)
      expect(sanitizeOutboundMessage("spectator", missingMsg)).toEqual(missingMsg)
    })

    it("preserves operator outbound messages without modification", () => {
      const sensitiveError = {
        kind: "error",
        generation: 3,
        message: "Duplicate binding for session-123 in /var/data/lane-1/pane-2",
      }
      const bindingMsg = { kind: "binding", generation: 3, binding: { id: "b1" } }

      expect(sanitizeOutboundMessage("operator", sensitiveError)).toEqual(sensitiveError)
      expect(sanitizeOutboundMessage("operator", bindingMsg)).toEqual(bindingMsg)
    })
  })
})
