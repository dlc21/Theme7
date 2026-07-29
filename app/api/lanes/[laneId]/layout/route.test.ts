import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { GET, PATCH } from "@/app/api/lanes/[laneId]/layout/route"
import { defaultLayout } from "@/lib/bento-layout"
import { createLane, database, getLane } from "@/lib/db"
import type { SavedLayoutV1 } from "@/lib/types"
import { markTerminalGuidanceStarted } from "../../../../../scripts/terminal-binding-store.mjs"

const originalDatabasePath = process.env.OPERATOR_ENGINE_DB_PATH
let root = ""

function resetDatabase(): void {
  globalThis.operatorEngineDatabase?.close()
  globalThis.operatorEngineDatabase = undefined
}

function patchRequest(layout: unknown, baseRevision: unknown): Request {
  return new Request("http://localhost/api/lanes/lane/layout", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout, baseRevision }),
  })
}

beforeEach(() => {
  resetDatabase()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-layout-route-"))
  process.env.OPERATOR_ENGINE_DB_PATH = path.join(root, "operator-engine.sqlite")
})

afterEach(() => {
  resetDatabase()
  if (originalDatabasePath === undefined) delete process.env.OPERATOR_ENGINE_DB_PATH
  else process.env.OPERATOR_ENGINE_DB_PATH = originalDatabasePath
  fs.rmSync(root, { recursive: true, force: true })
})

describe("lane layout revision API", () => {
  it("returns canonical layout, revision, and bindings without caching", async () => {
    const lane = createLane({
      name: "Read",
      path: path.join(root, "read-workspace"),
      layout: { schemaVersion: 1, tree: defaultLayout() },
      recipeId: null,
      recipeVersion: null,
      defaultHarness: "shell",
    })

    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ laneId: lane.id }) })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({
      layoutRevision: 0,
      terminalBindings: { "terminal-main": { generation: 1, harnessId: "shell" } },
    })
  })

  it("increments exactly once and rejects a stale snapshot without writing", async () => {
    const lane = createLane({
      name: "CAS",
      path: path.join(root, "cas-workspace"),
      layout: { schemaVersion: 1, tree: defaultLayout() },
      recipeId: null,
      recipeVersion: null,
      defaultHarness: "shell",
    })
    const initialTree = lane.layout!.tree
    const staleLastOpenedAt = "2025-01-01T00:00:00.000Z"
    database().prepare("UPDATE lanes SET last_opened_at = ? WHERE id = ?").run(staleLastOpenedAt, lane.id)
    if (initialTree.kind !== "split") throw new Error("Expected the default split layout.")
    const first: SavedLayoutV1 = { schemaVersion: 1, tree: { ...initialTree, percentage: 61 } }
    const saved = await PATCH(patchRequest(first, 0), { params: Promise.resolve({ laneId: lane.id }) })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ layoutRevision: 1, layout: { tree: { percentage: 61 } } })
    expect(getLane(lane.id)?.lastOpenedAt).not.toBe(staleLastOpenedAt)

    const conflictLastOpenedAt = "2025-02-01T00:00:00.000Z"
    database().prepare("UPDATE lanes SET last_opened_at = ? WHERE id = ?").run(conflictLastOpenedAt, lane.id)
    const stale: SavedLayoutV1 = { schemaVersion: 1, tree: { ...initialTree, percentage: 12 } }
    const conflict = await PATCH(patchRequest(stale, 0), { params: Promise.resolve({ laneId: lane.id }) })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      code: "LAYOUT_CONFLICT",
      error: "Lane layout changed in another window.",
      layoutRevision: 1,
      layout: { tree: { percentage: 61 } },
    })
    expect(getLane(lane.id)).toMatchObject({ layoutRevision: 1, layout: { tree: { percentage: 61 } } })
    expect(getLane(lane.id)?.lastOpenedAt).toBe(conflictLastOpenedAt)
  })

  it("requires a non-negative base revision and keeps binding-only writes revision-neutral", async () => {
    const lane = createLane({
      name: "Binding",
      path: path.join(root, "binding-workspace"),
      layout: { schemaVersion: 1, tree: defaultLayout() },
      recipeId: null,
      recipeVersion: null,
      defaultHarness: "shell",
    })
    const invalid = await PATCH(patchRequest(lane.layout, -1), { params: Promise.resolve({ laneId: lane.id }) })
    expect(invalid.status).toBe(400)

    const binding = lane.terminalBindings["terminal-main"]
    expect(markTerminalGuidanceStarted(database(), {
      laneId: lane.id,
      paneId: binding.paneId,
      generation: binding.generation,
    })?.kickoffSent).toBe(true)
    expect(getLane(lane.id)?.layoutRevision).toBe(0)
  })
})
