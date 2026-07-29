import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DELETE } from "@/app/api/lanes/[laneId]/panes/[paneId]/route"
import { defaultLayout } from "@/lib/bento-layout"
import { createLane, database } from "@/lib/db"
import * as relayControl from "@/lib/terminal-relay-control"

const originalDatabasePath = process.env.OPERATOR_ENGINE_DB_PATH
let root = ""
let laneIndex = 0

function resetDatabase(): void {
  globalThis.operatorEngineDatabase?.close()
  globalThis.operatorEngineDatabase = undefined
}

function createTestLane(panes = ["terminal", "files"]) {
  laneIndex += 1
  return createLane({
    name: `Lane ${laneIndex}`,
    path: path.join(root, `workspace-${laneIndex}`),
    layout: { schemaVersion: 1, tree: defaultLayout(panes) },
    recipeId: null,
    recipeVersion: null,
    defaultHarness: "shell",
  })
}

function closeRequest(baseRevision: unknown, expectedGeneration: unknown): Request {
  return new Request("http://localhost/api/lanes/lane/panes/pane", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision, expectedGeneration }),
  })
}

beforeEach(() => {
  resetDatabase()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-pane-close-"))
  process.env.OPERATOR_ENGINE_DB_PATH = path.join(root, "operator-engine.sqlite")
  vi.spyOn(relayControl, "terminateTerminalSession").mockResolvedValue(1)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDatabase()
  if (originalDatabasePath === undefined) delete process.env.OPERATOR_ENGINE_DB_PATH
  else process.env.OPERATOR_ENGINE_DB_PATH = originalDatabasePath
  fs.rmSync(root, { recursive: true, force: true })
})

describe("DELETE /api/lanes/[laneId]/panes/[paneId]", () => {
  it("commits the exact pane close before terminating only its deleted generation", async () => {
    const lane = createTestLane()
    const binding = lane.terminalBindings["terminal-main"]
    const response = await DELETE(
      closeRequest(lane.layoutRevision, binding.generation),
      { params: Promise.resolve({ laneId: lane.id, paneId: binding.paneId }) },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      layoutRevision: 1,
      terminalBindings: {},
      terminated: true,
      layout: { tree: { id: "files-main", pane: "files" } },
    })
    expect(relayControl.terminateTerminalSession).toHaveBeenCalledWith(lane.id, binding.paneId, binding.generation)
  })

  it("keeps the durable close committed when relay cleanup fails", async () => {
    vi.mocked(relayControl.terminateTerminalSession).mockRejectedValueOnce(new Error("relay offline"))
    const lane = createTestLane()
    const binding = lane.terminalBindings["terminal-main"]
    const response = await DELETE(
      closeRequest(lane.layoutRevision, binding.generation),
      { params: Promise.resolve({ laneId: lane.id, paneId: binding.paneId }) },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      layoutRevision: 1,
      terminalBindings: {},
      terminated: false,
      cleanupError: "Terminal pane closed, but its detached process could not be stopped.",
    })
  })

  it("returns canonical state for layout and binding conflicts without cleanup", async () => {
    const lane = createTestLane()
    const binding = lane.terminalBindings["terminal-main"]
    const staleLayout = await DELETE(
      closeRequest(lane.layoutRevision + 1, binding.generation),
      { params: Promise.resolve({ laneId: lane.id, paneId: binding.paneId }) },
    )
    expect(staleLayout.status).toBe(409)
    expect(await staleLayout.json()).toMatchObject({ code: "LAYOUT_CONFLICT", layoutRevision: 0 })

    const staleBinding = await DELETE(
      closeRequest(lane.layoutRevision, binding.generation + 1),
      { params: Promise.resolve({ laneId: lane.id, paneId: binding.paneId }) },
    )
    expect(staleBinding.status).toBe(409)
    expect(await staleBinding.json()).toMatchObject({ code: "TERMINAL_BINDING_CHANGED", layoutRevision: 0 })
    expect(relayControl.terminateTerminalSession).not.toHaveBeenCalled()
  })

  it("rejects invalid input, the last pane, and a missing binding with the named statuses", async () => {
    const invalid = await DELETE(
      closeRequest(-1, 0),
      { params: Promise.resolve({ laneId: "lane", paneId: "terminal-main" }) },
    )
    expect(invalid.status).toBe(400)

    const lastLane = createTestLane(["terminal"])
    const lastBinding = lastLane.terminalBindings["terminal-main"]
    const last = await DELETE(
      closeRequest(lastLane.layoutRevision, lastBinding.generation),
      { params: Promise.resolve({ laneId: lastLane.id, paneId: lastBinding.paneId }) },
    )
    expect(last.status).toBe(400)
    expect(await last.json()).toEqual({ code: "INVALID_LAST_PANE", error: "This Agent Terminal is the only pane in the lane." })

    const brokenLane = createTestLane()
    const brokenBinding = brokenLane.terminalBindings["terminal-main"]
    database().prepare("DELETE FROM terminal_bindings WHERE lane_id = ? AND pane_id = ?")
      .run(brokenLane.id, brokenBinding.paneId)
    const invariant = await DELETE(
      closeRequest(brokenLane.layoutRevision, brokenBinding.generation),
      { params: Promise.resolve({ laneId: brokenLane.id, paneId: brokenBinding.paneId }) },
    )
    expect(invariant.status).toBe(500)
    expect(await invariant.json()).toEqual({
      code: "TERMINAL_BINDING_INVARIANT",
      error: "Terminal pane has no binding.",
    })
  })
})
