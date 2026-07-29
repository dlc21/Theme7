import { beforeEach, describe, expect, it, vi } from "vitest"

import type { TerminalBinding } from "@/lib/types"

const state = vi.hoisted(() => ({
  binding: null as (TerminalBinding & { laneId: string }) | null,
  epoch: null as number | null,
  signed: [] as Array<Record<string, unknown>>,
  relaySawPersistedBinding: false,
  prewarmFailure: null as null | "definite" | "unknown",
  cancelFails: false,
  cancelCalls: [] as Array<{ laneId: string; paneId: string; generation: number }>,
  settleCalls: 0,
}))

vi.mock("@/lib/config", () => ({
  ompPrewarmEnabled: () => true,
  ompPrewarmTtlMs: () => 45_000,
}))
vi.mock("@/lib/db", () => ({
  database: () => ({}),
  getLane: () => ({
    id: "lane-1",
    layout: { schemaVersion: 1, tree: { kind: "pane", id: "files-main", pane: "files" } },
    defaultHarness: "omp",
    recipeId: null,
  }),
}))
vi.mock("@/lib/distributions", () => ({
  activeReviewedDistribution: () => Promise.resolve({ distribution: { id: "theme-7" } }),
  runtimeIdentity: () => ({ sourceCommit: null, distribution: "theme-7", role: "development", mode: "hmr", webPort: 4400, terminalPort: 4401, dataClass: "isolated", releaseId: null, contentSha256: null }),
}))
vi.mock("@/lib/terminal-ticket", () => ({
  signTerminalTicket: (payload: Record<string, unknown>) => {
    state.signed.push(payload)
    return "signed-ticket"
  },
  validateTerminalIdentity: () => undefined,
}))
vi.mock("@/lib/terminal-guidance", () => ({ terminalGuidance: () => Promise.resolve({ prompt: "", source: "none" }) }))
vi.mock("@/lib/terminal-relay-control", () => {
  class TerminalPrewarmRelayError extends Error {
    readonly spawned: boolean | null
    constructor(message: string, spawned: boolean | null) {
      super(message)
      this.spawned = spawned
    }
  }
  return {
    TerminalPrewarmRelayError,
    prewarmOmpTerminal: () => {
      state.relaySawPersistedBinding = Boolean(state.binding)
      if (state.prewarmFailure === "definite") throw new TerminalPrewarmRelayError("relay rejected", false)
      if (state.prewarmFailure === "unknown") throw new TerminalPrewarmRelayError("relay timeout", null)
      return Promise.resolve(123_456)
    },
    cancelPrewarmedOmpTerminal: (laneId: string, paneId: string, generation: number) => {
      state.cancelCalls.push({ laneId, paneId, generation })
      if (state.cancelFails) throw new Error("relay unavailable")
      if (state.binding?.generation === generation) state.binding = null
      return Promise.resolve(true)
    },
  }
})
vi.mock("../../../scripts/terminal-binding-store.mjs", () => ({
  getTerminalBinding: () => state.binding,
  planTerminalBindingCreation: () => state.binding ?? {
    expectedLastGeneration: state.epoch,
    nextGeneration: (state.epoch ?? 0) + 1,
  },
  createTerminalBinding: (_db: unknown, input: {
    laneId: string
    paneId: string
    harnessId: "omp"
    expectedLastGeneration: number | null
  }) => {
    if (state.binding || state.epoch !== input.expectedLastGeneration) return "epoch-conflict"
    const generation = (state.epoch ?? 0) + 1
    state.epoch = generation
    state.binding = {
      laneId: input.laneId,
      paneId: input.paneId,
      harnessId: "omp",
      resumeSessionId: null,
      kickoffSent: false,
      generation,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    return state.binding
  },
  settleTerminalReservation: (_db: unknown, input: { generation: number }) => {
    state.settleCalls += 1
    if (state.binding?.generation === input.generation) state.binding = null
    return { status: "deleted", binding: null }
  },
}))

import { DELETE, POST } from "@/app/api/terminal-prewarm/route"

function request(method: "POST" | "DELETE", body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/terminal-prewarm", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ laneId: "lane-1", paneId: "terminal-prewarm", ...body }),
  })
}

function existingBinding(generation = 2, resumeSessionId: string | null = null) {
  state.epoch = generation
  state.binding = {
    laneId: "lane-1",
    paneId: "terminal-prewarm",
    harnessId: "omp",
    resumeSessionId,
    kickoffSent: false,
    generation,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("OMP prewarm durable reservation", () => {
  beforeEach(() => {
    state.binding = null
    state.epoch = null
    state.signed = []
    state.relaySawPersistedBinding = false
    state.prewarmFailure = null
    state.cancelFails = false
    state.cancelCalls = []
    state.settleCalls = 0
  })

  it("persists a generation before relay spawn and returns that binding", async () => {
    const response = await POST(request("POST"))
    expect(response.status).toBe(200)
    expect(state.relaySawPersistedBinding).toBe(true)
    expect(state.signed).toEqual([expect.objectContaining({ generation: 1, mode: "start", harnessId: "omp" })])
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      expiresAt: 123_456,
      binding: { paneId: "terminal-prewarm", generation: 1, resumeSessionId: null },
    })
  })

  it("renews the exact generation without mutating durable identity", async () => {
    existingBinding(4)
    const before = state.binding
    const response = await POST(request("POST", { expectedGeneration: 4 }))
    expect(response.status).toBe(200)
    expect(state.binding).toBe(before)
    expect(state.signed).toEqual([expect.objectContaining({ generation: 4, mode: "attach" })])
  })

  it("renews after the reserved OMP process discovers its exact identity", async () => {
    existingBinding(4, "omp-session:early-identity")
    const before = state.binding
    const response = await POST(request("POST", { expectedGeneration: 4 }))
    expect(response.status).toBe(200)
    expect(state.binding).toBe(before)
    expect(state.signed).toEqual([expect.objectContaining({
      generation: 4,
      mode: "attach",
    })])
    await expect(response.json()).resolves.toMatchObject({
      binding: { generation: 4, resumeSessionId: "omp-session:early-identity" },
    })
  })

  it("returns canonical binding on stale renewal without calling relay", async () => {
    existingBinding(5)
    const response = await POST(request("POST", { expectedGeneration: 4 }))
    expect(response.status).toBe(409)
    expect(state.relaySawPersistedBinding).toBe(false)
    await expect(response.json()).resolves.toMatchObject({
      code: "TERMINAL_BINDING_CHANGED",
      binding: { generation: 5 },
    })
  })

  it("deletes a provisional binding after a definite no-spawn rejection", async () => {
    state.prewarmFailure = "definite"
    const response = await POST(request("POST"))
    expect(response.status).toBe(400)
    expect(state.settleCalls).toBe(1)
    expect(state.binding).toBeNull()
    expect(state.cancelCalls).toHaveLength(0)
  })

  it("preserves the existing reservation when renewal gets a definite no-spawn rejection", async () => {
    existingBinding(6)
    const before = state.binding
    state.prewarmFailure = "definite"
    const response = await POST(request("POST", { expectedGeneration: 6 }))
    expect(response.status).toBe(400)
    expect(state.binding).toBe(before)
    expect(state.settleCalls).toBe(0)
    expect(state.cancelCalls).toHaveLength(0)
    expect(state.signed).toEqual([expect.objectContaining({ generation: 6, mode: "attach" })])
  })

  it("preserves the existing reservation when renewal settlement is unknown", async () => {
    existingBinding(8)
    const before = state.binding
    state.prewarmFailure = "unknown"
    const response = await POST(request("POST", { expectedGeneration: 8 }))
    expect(response.status).toBe(400)
    expect(state.binding).toBe(before)
    expect(state.settleCalls).toBe(0)
    expect(state.cancelCalls).toHaveLength(0)
    expect(state.signed).toEqual([expect.objectContaining({ generation: 8, mode: "attach" })])
  })

  it("retains provisional identity when unknown relay settlement cannot be cancelled", async () => {
    state.prewarmFailure = "unknown"
    state.cancelFails = true
    const response = await POST(request("POST"))
    expect(response.status).toBe(400)
    expect(state.settleCalls).toBe(0)
    expect(state.binding?.generation).toBe(1)
    expect(state.cancelCalls).toEqual([{ laneId: "lane-1", paneId: "terminal-prewarm", generation: 1 }])
  })

  it("generation-binds explicit cancellation", async () => {
    existingBinding(7)
    const response = await DELETE(request("DELETE", { expectedGeneration: 7 }))
    expect(response.status).toBe(200)
    expect(state.cancelCalls).toEqual([{ laneId: "lane-1", paneId: "terminal-prewarm", generation: 7 }])
    expect(state.binding).toBeNull()
  })
})
