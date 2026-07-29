import { beforeEach, describe, expect, it, vi } from "vitest"

import { terminalPane } from "@/lib/bento-layout"
import type { HarnessId, TerminalBinding } from "@/lib/types"

const state = vi.hoisted(() => ({
  themeSeven: false,
  binding: null as TerminalBinding | null,
  signed: [] as Array<Record<string, unknown>>,
  failAdvance: false,
  failSign: false,
  advanceCalls: 0,
  events: [] as string[],
}))
const layout = { schemaVersion: 1 as const, tree: terminalPane("terminal-main", "first") }

vi.mock("@/lib/db", () => ({
  database: () => ({}),
  getLane: () => ({
    id: "lane-1",
    layout,
    layoutRevision: 0,
    terminalBindings: state.binding ? { "terminal-main": state.binding } : {},
    recipeId: null,
  }),
}))
vi.mock("@/lib/distributions", () => ({
  activeReviewedDistribution: () => state.themeSeven ? Promise.resolve({ distribution: { id: "theme-7" } }) : Promise.resolve(null),
  runtimeIdentity: (distribution: "stock" | "theme-7") => ({ sourceCommit: null, distribution, role: "development", mode: "hmr", webPort: 4400, terminalPort: 4401, dataClass: "isolated", releaseId: null, contentSha256: null }),
}))
vi.mock("@/lib/terminal-ticket", () => ({
  signTerminalTicket: (payload: Record<string, unknown>) => {
    state.signed.push(payload)
    state.events.push(`sign:${String(payload.generation)}`)
    if (state.failSign) throw new Error("Ticket signing failed.")
    return `signed-ticket-${String(payload.generation)}`
  },
  validateTerminalIdentity: () => undefined,
}))
vi.mock("@/lib/terminal-guidance", () => ({ terminalGuidance: () => Promise.resolve({ prompt: "", source: "none" }) }))
vi.mock("../../../scripts/terminal-binding-store.mjs", () => ({
  advanceTerminalBinding: (_db: unknown, input: {
    expected: TerminalBinding
    harnessId: HarnessId
    resume: string | null
  }) => {
    state.advanceCalls += 1
    state.events.push("advance")
    if (state.failAdvance && state.binding) {
      state.binding = {
        ...state.binding,
        generation: state.binding.generation + 1,
        updatedAt: "2026-01-01T00:00:01.000Z",
      }
      return null
    }
    if (!state.binding
      || state.binding.generation !== input.expected.generation
      || state.binding.harnessId !== input.expected.harnessId
      || state.binding.resumeSessionId !== input.expected.resumeSessionId
      || state.binding.kickoffSent !== input.expected.kickoffSent) return null
    state.binding = {
      ...state.binding,
      harnessId: input.harnessId,
      resumeSessionId: input.resume,
      kickoffSent: false,
      generation: state.binding.generation + 1,
      updatedAt: "2026-01-01T00:00:01.000Z",
    }
    return { laneId: "lane-1", ...state.binding }
  },
}))

import { POST } from "@/app/api/terminal-ticket/route"

function binding(harnessId: HarnessId = "shell", resumeSessionId: string | null = null, generation = 1): TerminalBinding {
  return {
    paneId: "terminal-main",
    harnessId,
    resumeSessionId,
    kickoffSent: false,
    generation,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function ticketRequest(action: string, extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/terminal-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ laneId: "lane-1", paneId: "terminal-main", action, ...extra }),
  })
}

describe("binding-authoritative terminal tickets", () => {
  beforeEach(() => {
    state.themeSeven = false
    state.binding = binding()
    state.signed = []
    state.failAdvance = false
    state.failSign = false
    state.advanceCalls = 0
    state.events = []
  })

  it.each([
    ["stock", "shell", 200],
    ["stock", "codex", 200],
    ["stock", "omp", 400],
    ["theme-7", "shell", 200],
    ["theme-7", "omp", 200],
    ["theme-7", "codex", 400],
  ] as const)("authorizes %s %s attach from the durable binding", async (distribution, harnessId, status) => {
    state.themeSeven = distribution === "theme-7"
    state.binding = binding(harnessId)
    const response = await POST(ticketRequest("attach"))
    expect(response.status).toBe(status)
    if (status === 200) {
      expect(state.binding?.generation).toBe(1)
      expect(state.signed.at(-1)).toMatchObject({ harnessId, generation: 1, mode: "attach" })
    }
  })

  it("signs the proposed generation before atomically advancing a fresh-session binding", async () => {
    const response = await POST(ticketRequest("start", { harnessId: "codex", expectedGeneration: 1 }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ticket: "signed-ticket-2",
      mode: "start",
      binding: { harnessId: "codex", generation: 2, resumeSessionId: null },
    })
    expect(state.signed.at(-1)).toMatchObject({ harnessId: "codex", generation: 2, mode: "start" })
    expect(state.events).toEqual(["sign:2", "advance"])
  })

  it.each([
    ["stock", "omp", "shell"],
    ["theme-7", "codex", "omp"],
  ] as const)("authorizes a %s replacement from unavailable %s to requested %s", async (distribution, oldHarness, requestedHarness) => {
    state.themeSeven = distribution === "theme-7"
    state.binding = binding(oldHarness)
    const response = await POST(ticketRequest("new-session", { harnessId: requestedHarness, expectedGeneration: 1 }))
    expect(response.status).toBe(200)
    expect(state.binding).toMatchObject({ harnessId: requestedHarness, generation: 2 })
    expect(state.signed.at(-1)).toMatchObject({ harnessId: requestedHarness, generation: 2, mode: "start" })
  })

  it("does not advance the durable binding when proposed ticket signing fails", async () => {
    state.failSign = true
    const response = await POST(ticketRequest("new-session", { harnessId: "codex", expectedGeneration: 1 }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: "Ticket signing failed." })
    expect(state.advanceCalls).toBe(0)
    expect(state.binding).toEqual(binding())
    expect(state.events).toEqual(["sign:2"])
  })

  it("resumes only the exact OMP id stored in the expected binding generation", async () => {
    state.themeSeven = true
    state.binding = binding("omp", "session-123", 3)
    const response = await POST(ticketRequest("resume-bound", { expectedGeneration: 3 }))
    expect(response.status).toBe(200)
    expect(state.signed.at(-1)).toMatchObject({
      harnessId: "omp",
      generation: 4,
      mode: "resume-exact",
      resumeSessionId: "session-123",
    })
    expect(state.binding).toMatchObject({ generation: 4, resumeSessionId: "session-123" })
  })

  it("coalesces a stale exact-resume request onto the generation another window already advanced", async () => {
    state.themeSeven = true
    state.binding = binding("omp", "session-123", 4)
    const response = await POST(ticketRequest("resume-bound", { expectedGeneration: 3 }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      mode: "resume-exact",
      binding: { generation: 4, resumeSessionId: "session-123" },
    })
    expect(state.signed).toHaveLength(1)
    expect(state.signed[0]).toMatchObject({ generation: 4, mode: "resume-exact", resumeSessionId: "session-123" })
  })

  it("coalesces an exact-resume compare-and-swap race after both windows read the old generation", async () => {
    state.themeSeven = true
    state.binding = binding("omp", "session-123", 3)
    state.failAdvance = true
    const response = await POST(ticketRequest("resume-bound", { expectedGeneration: 3 }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      mode: "resume-exact",
      binding: { generation: 4, resumeSessionId: "session-123" },
    })
    expect(state.signed).toHaveLength(2)
    expect(state.signed[0]).toMatchObject({ generation: 4, mode: "resume-exact", resumeSessionId: "session-123" })
    expect(state.signed[1]).toMatchObject({ generation: 4, mode: "resume-exact", resumeSessionId: "session-123" })
  })

  it("discards a signed proposed ticket when a non-resume compare-and-swap loses", async () => {
    state.failAdvance = true
    const response = await POST(ticketRequest("new-session", { harnessId: "codex", expectedGeneration: 1 }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: "TERMINAL_BINDING_CHANGED",
      binding: { generation: 2, harnessId: "shell" },
    })
    expect(state.advanceCalls).toBe(1)
    expect(state.signed).toHaveLength(1)
    expect(state.signed[0]).toMatchObject({ generation: 2, harnessId: "codex", mode: "start" })
  })

  it("returns the current binding without signing when the expected generation is stale", async () => {
    state.binding = binding("shell", null, 4)
    const response = await POST(ticketRequest("new-session", { harnessId: "shell", expectedGeneration: 3 }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: "TERMINAL_BINDING_CHANGED",
      binding: { generation: 4 },
    })
    expect(state.signed).toHaveLength(0)
  })

  it("fails closed when the visual terminal has no durable binding", async () => {
    state.binding = null
    const response = await POST(ticketRequest("attach"))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ code: "TERMINAL_BINDING_INVARIANT" })
    expect(state.signed).toHaveLength(0)
  })
})
