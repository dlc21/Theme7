import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { findPane, paneIds, parseSavedLayout, removePane } from "@/lib/bento-layout"
import { databasePath } from "@/lib/config"
import type { HarnessId, Lane, LaneLayoutState, SavedLayoutV1, TerminalBinding, ThreadLink } from "@/lib/types"
import {
  createTerminalBinding,
  deleteTerminalBinding,
  ensureTerminalContinuitySchema,
  listTerminalBindings,
} from "../scripts/terminal-binding-store.mjs"
import type { StoredTerminalBinding } from "../scripts/terminal-binding-store.mjs"

type DbLane = {
  id: string
  name: string
  path: string
  created_at: string
  last_opened_at: string
  layout_json: string | null
  layout_revision: number
  recipe_id: string | null
  recipe_version: number | null
  default_harness: string | null
  thread_links_json?: string | null
}

declare global {
  // eslint-disable-next-line no-var
  var operatorEngineDatabase: Database.Database | undefined
}

function addColumnIfMissing(db: Database.Database, name: string, declaration: string): void {
  const columns = db.prepare("PRAGMA table_info(lanes)").all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE lanes ADD COLUMN ${name} ${declaration}`)
}

function openDatabase(): Database.Database {
  const file = databasePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(`
    CREATE TABLE IF NOT EXISTS lanes (
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
  addColumnIfMissing(db, "layout_json", "TEXT")
  addColumnIfMissing(db, "recipe_id", "TEXT")
  addColumnIfMissing(db, "recipe_version", "INTEGER")
  addColumnIfMissing(db, "default_harness", "TEXT NOT NULL DEFAULT 'shell'")
  addColumnIfMissing(db, "thread_links_json", "TEXT NOT NULL DEFAULT '[]'")
  if (!ensureTerminalContinuitySchema(db)) throw new Error("Terminal continuity schema is not ready.")
  return db
}

export function database(): Database.Database {
  globalThis.operatorEngineDatabase ??= openDatabase()
  return globalThis.operatorEngineDatabase
}

function harnessId(value: string | null): HarnessId {
  return value === "omp" || value === "codex" || value === "shell" ? value : "shell"
}

function terminalBinding(binding: StoredTerminalBinding): TerminalBinding {
  return {
    paneId: binding.paneId,
    harnessId: binding.harnessId,
    resumeSessionId: binding.resumeSessionId,
    kickoffSent: binding.kickoffSent,
    generation: binding.generation,
    updatedAt: binding.updatedAt,
  }
}

function terminalBindingRecord(bindings: StoredTerminalBinding[]): Record<string, TerminalBinding> {
  const result: Record<string, TerminalBinding> = {}
  for (const binding of bindings) result[binding.paneId] = terminalBinding(binding)
  return result
}

function parseThreadLinks(raw: string | null | undefined): ThreadLink[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function laneFromRow(row: DbLane, bindings: StoredTerminalBinding[]): Lane {
  const fallback = harnessId(row.default_harness)
  let layout: SavedLayoutV1 | null = null
  if (row.layout_json) {
    try { layout = parseSavedLayout(JSON.parse(row.layout_json)) } catch { layout = null }
  }
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    layout,
    layoutRevision: row.layout_revision,
    terminalBindings: terminalBindingRecord(bindings),
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    defaultHarness: fallback,
    threadLinks: parseThreadLinks(row.thread_links_json),
  }
}

function readSnapshot<T>(db: Database.Database, operation: () => T): T {
  if (db.inTransaction) return operation()
  db.exec("BEGIN")
  try {
    const result = operation()
    db.exec("COMMIT")
    return result
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK")
    throw error
  }
}

function writeTransaction<T>(db: Database.Database, operation: () => T): T {
  if (db.inTransaction) return operation()
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = operation()
    db.exec("COMMIT")
    return result
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK")
    throw error
  }
}

function laneLayoutState(lane: Lane): LaneLayoutState {
  return {
    layout: lane.layout,
    layoutRevision: lane.layoutRevision,
    terminalBindings: lane.terminalBindings,
  }
}

export function listLanes(): Lane[] {
  const db = database()
  return readSnapshot(db, () => {
    const rows = db.prepare("SELECT * FROM lanes ORDER BY last_opened_at DESC").all() as DbLane[]
    const bindings = listTerminalBindings(db)
    const grouped = new Map<string, StoredTerminalBinding[]>()
    for (const binding of bindings) {
      const laneBindings = grouped.get(binding.laneId) ?? []
      laneBindings.push(binding)
      grouped.set(binding.laneId, laneBindings)
    }
    return rows.map((row) => laneFromRow(row, grouped.get(row.id) ?? []))
  })
}

export function getLane(id: string): Lane | null {
  const db = database()
  return readSnapshot(db, () => {
    const row = db.prepare("SELECT * FROM lanes WHERE id = ?").get(id) as DbLane | undefined
    return row ? laneFromRow(row, listTerminalBindings(db, id)) : null
  })
}

function terminalPaneIds(layout: SavedLayoutV1): string[] {
  const result: string[] = []
  const visit = (node: SavedLayoutV1["tree"]): void => {
    if (node.kind === "pane") {
      if (node.pane === "terminal") result.push(node.id)
      return
    }
    if (node.kind === "tabs") {
      for (const pane of node.panes) visit(pane)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout.tree)
  return result
}

export function createLane(input: {
  name: string
  path: string
  layout: SavedLayoutV1
  recipeId: string | null
  recipeVersion: number | null
  defaultHarness: HarnessId
}): Lane {
  const db = database()
  return writeTransaction(db, () => {
    const now = new Date().toISOString()
    const id = randomUUID()
    db.prepare(`
      INSERT INTO lanes (
        id, name, path, created_at, last_opened_at, layout_json, recipe_id, recipe_version, default_harness
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.path, now, now,
      JSON.stringify(input.layout), input.recipeId, input.recipeVersion, input.defaultHarness,
    )
    for (const paneId of terminalPaneIds(input.layout)) {
      createTerminalBinding(db, { laneId: id, paneId, harnessId: input.defaultHarness })
    }
    const lane = getLane(id)
    if (!lane) throw new Error("Created lane could not be read.")
    return lane
  })
}

export function updateLaneSettings(id: string, input: { name: string; defaultHarness: HarnessId }): Lane | null {
  database().prepare("UPDATE lanes SET name = ?, default_harness = ? WHERE id = ?")
    .run(input.name, input.defaultHarness, id)
  return getLane(id)
}

export function updateLaneThreadLinks(laneId: string, threadLinks: ThreadLink[]): Lane | null {
  database().prepare("UPDATE lanes SET thread_links_json = ?, last_opened_at = ? WHERE id = ?")
    .run(JSON.stringify(threadLinks), new Date().toISOString(), laneId)
  return getLane(laneId)
}

export type SaveLaneLayoutResult =
  | { status: "saved"; state: LaneLayoutState }
  | { status: "conflict"; state: LaneLayoutState }
  | { status: "missing" }

export function saveLaneLayout(id: string, layout: SavedLayoutV1, baseRevision: number): SaveLaneLayoutResult {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error("Invalid layout revision.")
  const db = database()
  return writeTransaction(db, () => {
    const row = db.prepare("SELECT * FROM lanes WHERE id = ?").get(id) as DbLane | undefined
    if (!row) return { status: "missing" }
    const lane = laneFromRow(row, listTerminalBindings(db, id))
    if (row.layout_revision !== baseRevision) {
      return { status: "conflict", state: laneLayoutState(lane) }
    }
    const currentTerminalIds = new Set(lane.layout ? terminalPaneIds(lane.layout) : [])
    const proposedTerminalIds = new Set(terminalPaneIds(layout))
    for (const paneId of currentTerminalIds) {
      if (!proposedTerminalIds.has(paneId)) {
        throw new Error("Terminal panes must be closed through the terminal pane endpoint.")
      }
    }
    db.prepare(`
      UPDATE lanes
      SET layout_json = ?, layout_revision = layout_revision + 1, last_opened_at = ?
      WHERE id = ? AND layout_revision = ?
    `).run(JSON.stringify(layout), new Date().toISOString(), id, baseRevision)
    for (const paneId of proposedTerminalIds) {
      if (!currentTerminalIds.has(paneId)) {
        createTerminalBinding(db, { laneId: id, paneId, harnessId: lane.defaultHarness })
      }
    }
    const updatedRow = db.prepare("SELECT * FROM lanes WHERE id = ?").get(id) as DbLane
    const updated = laneFromRow(updatedRow, listTerminalBindings(db, id))
    return { status: "saved", state: laneLayoutState(updated) }
  })
}

export type CloseTerminalPaneResult =
  | { status: "layout-conflict"; state: LaneLayoutState }
  | { status: "binding-conflict"; state: LaneLayoutState }
  | { status: "missing-lane" }
  | { status: "missing-pane" }
  | { status: "invalid-last-pane" }
  | { status: "missing-binding" }
  | { status: "closed"; state: LaneLayoutState; deletedGeneration: number }

export function closeTerminalPane(input: {
  laneId: string
  paneId: string
  baseRevision: number
  expectedGeneration: number
}): CloseTerminalPaneResult {
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new Error("Invalid layout revision.")
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) throw new Error("Invalid terminal binding generation.")
  const db = database()
  return writeTransaction(db, () => {
    const row = db.prepare("SELECT * FROM lanes WHERE id = ?").get(input.laneId) as DbLane | undefined
    if (!row) return { status: "missing-lane" }
    const lane = laneFromRow(row, listTerminalBindings(db, input.laneId))
    if (row.layout_revision !== input.baseRevision) {
      return { status: "layout-conflict", state: laneLayoutState(lane) }
    }
    if (!lane.layout) return { status: "missing-pane" }
    const pane = findPane(lane.layout.tree, input.paneId)
    if (!pane || pane.pane !== "terminal") return { status: "missing-pane" }
    if (paneIds(lane.layout.tree).length <= 1) return { status: "invalid-last-pane" }
    const binding = lane.terminalBindings[input.paneId]
    if (!binding) return { status: "missing-binding" }
    if (binding.generation !== input.expectedGeneration) {
      return { status: "binding-conflict", state: laneLayoutState(lane) }
    }
    const tree = removePane(lane.layout.tree, input.paneId)
    if (!tree) return { status: "invalid-last-pane" }
    const nextLayout: SavedLayoutV1 = { schemaVersion: 1, tree }
    db.prepare(`
      UPDATE lanes
      SET layout_json = ?, layout_revision = layout_revision + 1, last_opened_at = ?
      WHERE id = ? AND layout_revision = ?
    `).run(JSON.stringify(nextLayout), new Date().toISOString(), input.laneId, input.baseRevision)
    const deleted = deleteTerminalBinding(db, {
      laneId: input.laneId,
      paneId: input.paneId,
      expectedGeneration: input.expectedGeneration,
    })
    if (!deleted) throw new Error("Terminal binding changed during pane close.")
    const updatedRow = db.prepare("SELECT * FROM lanes WHERE id = ?").get(input.laneId) as DbLane
    const updated = laneFromRow(updatedRow, listTerminalBindings(db, input.laneId))
    return {
      status: "closed",
      state: laneLayoutState(updated),
      deletedGeneration: deleted.generation,
    }
  })
}

export function touchLane(id: string): void {
  database().prepare("UPDATE lanes SET last_opened_at = ? WHERE id = ?").run(new Date().toISOString(), id)
}

export function removeLane(id: string): void {
  database().prepare("DELETE FROM lanes WHERE id = ?").run(id)
}
