import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { defaultLayout } from "@/lib/bento-layout"
import { closeTerminalPane, createLane, database, getLane, removeLane } from "@/lib/db"
import type { SavedLayoutV1 } from "@/lib/types"

const originalDatabasePath = process.env.OPERATOR_ENGINE_DB_PATH
let root = ""
let databaseFile = ""

function resetDatabase(): void {
  globalThis.operatorEngineDatabase?.close()
  globalThis.operatorEngineDatabase = undefined
}

function layout(panes = ["terminal", "files"]): SavedLayoutV1 {
  return { schemaVersion: 1, tree: defaultLayout(panes) }
}

beforeEach(() => {
  resetDatabase()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-db-"))
  databaseFile = path.join(root, "theme7.sqlite")
  process.env.OPERATOR_ENGINE_DB_PATH = databaseFile
})

afterEach(() => {
  resetDatabase()
  if (originalDatabasePath === undefined) delete process.env.OPERATOR_ENGINE_DB_PATH
  else process.env.OPERATOR_ENGINE_DB_PATH = originalDatabasePath
  fs.rmSync(root, { recursive: true, force: true })
})

describe("lane terminal continuity database", () => {
  it("hydrates a migrated legacy layout and binding from one lane read", () => {
    const raw = new Database(databaseFile)
    raw.exec(`
      CREATE TABLE lanes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL,
        layout_json TEXT,
        recipe_id TEXT,
        recipe_version INTEGER,
        default_harness TEXT NOT NULL DEFAULT 'shell'
      );
    `)
    raw.prepare(`
      INSERT INTO lanes (
        id, name, path, created_at, last_opened_at, layout_json, recipe_id, recipe_version, default_harness
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      "lane-legacy",
      "Legacy",
      path.join(root, "workspace"),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      JSON.stringify({
        schemaVersion: 1,
        tree: {
          kind: "pane",
          id: "terminal-main",
          pane: "terminal",
          config: {
            harnessId: "omp",
            role: "first",
            kickoffSent: true,
            resumeSessionId: "omp-session:legacy",
          },
        },
      }),
      "omp",
    )
    raw.close()

    const lane = getLane("lane-legacy")
    expect(lane).toMatchObject({ id: "lane-legacy", layoutRevision: 0 })
    expect(lane?.terminalBindings["terminal-main"]).toMatchObject({
      harnessId: "omp",
      resumeSessionId: "omp-session:legacy",
      kickoffSent: true,
      generation: 1,
    })
  })

  it("creates every initial terminal binding in the lane transaction", () => {
    const lane = createLane({
      name: "Created",
      path: path.join(root, "created-workspace"),
      layout: layout(["terminal", "files", "terminal"]),
      recipeId: null,
      recipeVersion: null,
      defaultHarness: "omp",
    })

    expect(lane.layoutRevision).toBe(0)
    expect(Object.values(lane.terminalBindings)).toHaveLength(2)
    expect(Object.values(lane.terminalBindings)).toEqual(expect.arrayContaining([
      expect.objectContaining({ paneId: "terminal-main", harnessId: "omp", generation: 1 }),
      expect.objectContaining({ paneId: "terminal-1", harnessId: "omp", generation: 1 }),
    ]))
  })

  it("atomically closes one terminal while retaining its epoch", () => {
    const lane = createLane({
      name: "Close",
      path: path.join(root, "close-workspace"),
      layout: layout(),
      recipeId: null,
      recipeVersion: null,
      defaultHarness: "shell",
    })
    const binding = lane.terminalBindings["terminal-main"]
    const staleLastOpenedAt = "2025-01-01T00:00:00.000Z"
    database().prepare("UPDATE lanes SET last_opened_at = ? WHERE id = ?").run(staleLastOpenedAt, lane.id)

    expect(closeTerminalPane({
      laneId: lane.id,
      paneId: "terminal-main",
      baseRevision: lane.layoutRevision + 1,
      expectedGeneration: binding.generation,
    })).toMatchObject({ status: "layout-conflict", state: { layoutRevision: 0 } })
    expect(getLane(lane.id)?.lastOpenedAt).toBe(staleLastOpenedAt)

    const closed = closeTerminalPane({
      laneId: lane.id,
      paneId: "terminal-main",
      baseRevision: lane.layoutRevision,
      expectedGeneration: binding.generation,
    })
    expect(closed).toMatchObject({
      status: "closed",
      deletedGeneration: 1,
      state: { layoutRevision: 1, terminalBindings: {} },
    })
    expect(getLane(lane.id)?.layout?.tree).toMatchObject({ id: "files-main", pane: "files" })
    expect(getLane(lane.id)?.lastOpenedAt).not.toBe(staleLastOpenedAt)
    expect(database().prepare(`
      SELECT last_generation FROM terminal_binding_epochs WHERE lane_id = ? AND pane_id = ?
    `).get(lane.id, "terminal-main")).toEqual({ last_generation: 1 })
  })

  it("cascades both active bindings and retained epochs when a lane is deleted", () => {
    const lane = createLane({
      name: "Delete",
      path: path.join(root, "delete-workspace"),
      layout: layout(),
      recipeId: null,
      recipeVersion: null,
      defaultHarness: "shell",
    })
    removeLane(lane.id)

    expect(database().prepare("SELECT COUNT(*) AS count FROM terminal_bindings WHERE lane_id = ?").get(lane.id)).toEqual({ count: 0 })
    expect(database().prepare("SELECT COUNT(*) AS count FROM terminal_binding_epochs WHERE lane_id = ?").get(lane.id)).toEqual({ count: 0 })
  })
})
