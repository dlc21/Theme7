import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  tmpDir: "",
  lanes: new Map<string, { id: string; name: string; path: string; threadLinks?: Array<Record<string, unknown>> }>(),
}))

vi.mock("@/lib/db", () => ({
  getLane: (id: string) => state.lanes.get(id) ?? null,
  updateLaneThreadLinks: (laneId: string, threadLinks: Array<Record<string, unknown>>) => {
    const lane = state.lanes.get(laneId)
    if (!lane) return null
    lane.threadLinks = threadLinks
    state.lanes.set(laneId, lane)
    return lane
  },
}))

import { GET, POST } from "@/app/api/lanes/[laneId]/ingest-omp/route"

describe("OMP Ingestion API Route", () => {
  beforeEach(async () => {
    state.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ingest-test-"))
    process.env.OPERATOR_STUDIO_OMP_ROOTS = state.tmpDir

    state.lanes.clear()
    state.lanes.set("lane-1", {
      id: "lane-1",
      name: "Test Lane",
      path: "/tmp/test-lane",
      threadLinks: [],
    })

    // Write a valid fixture OMP session JSONL file
    const sessionFile = path.join(state.tmpDir, "session_test123.jsonl")
    const lines = [
      JSON.stringify({ type: "session", version: "v1", id: "test123", title: "Debug Sidebar Glitch" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Why is sidebar glitching?", timestamp: "2026-07-21T10:00:00Z" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "The layout state was cached.", timestamp: "2026-07-21T10:00:05Z" } }),
    ]
    await fs.writeFile(sessionFile, lines.join("\n"), "utf8")
  })

  afterEach(async () => {
    delete process.env.OPERATOR_STUDIO_OMP_ROOTS
    if (state.tmpDir) {
      await fs.rm(state.tmpDir, { recursive: true, force: true })
    }
  })

  it("returns safe local OMP inventory without exposing paths, transcript bodies, or secrets", async () => {
    const context = { params: Promise.resolve({ laneId: "lane-1" }) }
    const response = await GET(new Request("http://localhost/api/lanes/lane-1/ingest-omp"), context)

    expect(response.status).toBe(200)
    const data = await response.json() as { provider: string; sessions: Array<Record<string, unknown>> }

    expect(data.provider).toBe("omp")
    expect(data.sessions).toHaveLength(1)

    const session = data.sessions[0]!
    expect(session.sourceSessionId).toBe("omp-test123")
    expect(session.title).toBe("Debug Sidebar Glitch")
    expect(session.messageCount).toBe(2)
    expect(session.alreadyImported).toBe(false)
    expect(session.providerId).toBe("omp")

    // Privacy security verification: safe inventory MUST NOT expose file path, raw content, or secrets
    expect(session).not.toHaveProperty("path")
    expect(session).not.toHaveProperty("content")
    expect(session).not.toHaveProperty("messages")
    expect(session).not.toHaveProperty("secret")
  })

  it("explicitly ingests an OMP session into the lane idempotently", async () => {
    const context = { params: Promise.resolve({ laneId: "lane-1" }) }

    // First ingestion
    const res1 = await POST(new Request("http://localhost/api/lanes/lane-1/ingest-omp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceSessionId: "omp-test123" }),
    }), context)

    expect(res1.status).toBe(200)
    const data1 = await res1.json() as { ok: boolean; threadLink: Record<string, unknown> }
    expect(data1.ok).toBe(true)
    expect(data1.threadLink.sourceSessionId).toBe("omp-test123")
    expect(data1.threadLink.title).toBe("Debug Sidebar Glitch")
    expect(data1.threadLink.messageCount).toBe(2)

    const lane1 = state.lanes.get("lane-1")!
    expect(lane1.threadLinks).toHaveLength(1)

    // Repeat ingestion (Idempotence check)
    const res2 = await POST(new Request("http://localhost/api/lanes/lane-1/ingest-omp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceSessionId: "omp-test123" }),
    }), context)

    expect(res2.status).toBe(200)
    const lane2 = state.lanes.get("lane-1")!
    // Should NOT duplicate the thread link record
    expect(lane2.threadLinks).toHaveLength(1)
  })

  it("returns 404 for an unknown lane", async () => {
    const context = { params: Promise.resolve({ laneId: "unknown-lane" }) }
    const response = await GET(new Request("http://localhost/api/lanes/unknown-lane/ingest-omp"), context)
    expect(response.status).toBe(404)
  })

  it("returns 400 when sourceSessionId is missing or invalid", async () => {
    const context = { params: Promise.resolve({ laneId: "lane-1" }) }
    const response = await POST(new Request("http://localhost/api/lanes/lane-1/ingest-omp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceSessionId: "nonexistent-session-id" }),
    }), context)

    expect(response.status).toBe(400)
  })

  it("performs partial header inventory scans on multi-megabyte sessions without reading full transcript bodies", async () => {
    const sessionHeader = JSON.stringify({ type: "session", id: "large999", title: "Large Session Scan", version: "v1" })
    const hugeFile = path.join(state.tmpDir, "session_large999.jsonl")
    const hugeContent = sessionHeader + "\n" + "Z".repeat(5 * 1024 * 1024) + "\n"
    await fs.writeFile(hugeFile, hugeContent, "utf8")

    const context = { params: Promise.resolve({ laneId: "lane-1" }) }
    const response = await GET(new Request("http://localhost/api/lanes/lane-1/ingest-omp"), context)

    expect(response.status).toBe(200)
    const data = await response.json() as { provider: string; sessions: Array<Record<string, unknown>> }

    const largeSession = data.sessions.find((s) => s.sourceSessionId === "omp-large999")
    expect(largeSession).toBeDefined()
    expect(largeSession?.title).toBe("Large Session Scan")
  })
})
