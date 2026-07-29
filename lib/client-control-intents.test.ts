import { afterEach, describe, expect, it, vi } from "vitest"

import {
  acknowledgeClientControlIntent,
  clearClientControlIntentsForTests,
  listClientControlIntents,
  queueClientControlIntent,
} from "@/lib/client-control-intents"

afterEach(() => { clearClientControlIntentsForTests(); vi.useRealTimers() })

describe("browser control intents", () => {
  it("isolates lanes, acknowledges once, and expires in memory", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const first = queueClientControlIntent({ kind: "open_web_preview", laneId: "lane-1", sourcePaneId: "terminal-1", location: "demo/index.html", ttlMs: 5_000 })
    queueClientControlIntent({ kind: "open_web_preview", laneId: "lane-2", sourcePaneId: "terminal-2", location: "http://127.0.0.1:3000/" })
    expect(listClientControlIntents("lane-1")).toEqual([first])
    expect(acknowledgeClientControlIntent("lane-2", first.id)).toBe(false)
    expect(acknowledgeClientControlIntent("lane-1", first.id)).toBe(true)
    expect(acknowledgeClientControlIntent("lane-1", first.id)).toBe(false)
    const expiring = queueClientControlIntent({ kind: "close_terminal", laneId: "lane-1", sourcePaneId: "terminal-1", expectedGeneration: 1, ttlMs: 5_000 })
    vi.advanceTimersByTime(5_001)
    expect(listClientControlIntents(expiring.laneId)).toEqual([])
  })

  it("coalesces an unexpired close only for the same lane, pane, and generation", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const first = queueClientControlIntent({ kind: "close_terminal", laneId: "lane-1", sourcePaneId: "terminal-1", expectedGeneration: 1 })
    vi.advanceTimersByTime(1_000)
    const duplicate = queueClientControlIntent({ kind: "close_terminal", laneId: "lane-1", sourcePaneId: "terminal-1", expectedGeneration: 1 })
    const newerGeneration = queueClientControlIntent({ kind: "close_terminal", laneId: "lane-1", sourcePaneId: "terminal-1", expectedGeneration: 2 })
    const otherPane = queueClientControlIntent({ kind: "close_terminal", laneId: "lane-1", sourcePaneId: "terminal-2", expectedGeneration: 1 })
    const otherLane = queueClientControlIntent({ kind: "close_terminal", laneId: "lane-2", sourcePaneId: "terminal-1", expectedGeneration: 1 })

    expect(duplicate).toBe(first)
    expect(duplicate.expiresAt).toBe(first.expiresAt)
    expect(listClientControlIntents("lane-1")).toEqual([first, newerGeneration, otherPane])
    expect(listClientControlIntents("lane-2")).toEqual([otherLane])
  })

  it("keeps Web Preview intents distinct and chronologically ordered", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const first = queueClientControlIntent({ kind: "open_web_preview", laneId: "lane-1", sourcePaneId: "terminal-1", location: "one.html" })
    vi.advanceTimersByTime(1)
    const second = queueClientControlIntent({ kind: "open_web_preview", laneId: "lane-1", sourcePaneId: "terminal-1", location: "one.html" })
    expect(second.id).not.toBe(first.id)
    expect(listClientControlIntents("lane-1")).toEqual([first, second])
  })

  it("clamps intent expiry from five to sixty seconds", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const minimum = queueClientControlIntent({ kind: "close_terminal", laneId: "lane-1", sourcePaneId: "terminal-1", expectedGeneration: 1, ttlMs: 1 })
    const maximum = queueClientControlIntent({ kind: "open_web_preview", laneId: "lane-1", sourcePaneId: "terminal-1", location: "one.html", ttlMs: 600_000 })
    expect(minimum.expiresAt).toBe(Date.now() + 5_000)
    expect(maximum.expiresAt).toBe(Date.now() + 60_000)
  })
})
