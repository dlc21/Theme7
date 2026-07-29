import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import {
  advanceTerminalBinding,
  createTerminalBinding,
  deleteAbandonedTerminalBindings,
  deleteTerminalBinding,
  ensureTerminalContinuitySchema,
  getTerminalBinding,
  listTerminalBindings,
  markTerminalGuidanceStarted,
  planTerminalBindingCreation,
  setTerminalBindingIdentity,
  settleTerminalReservation,
} from "./terminal-binding-store.mjs"

const roots = []
const databases = []

function openDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-binding-store-"))
  roots.push(root)
  const db = new Database(path.join(root, "theme7.sqlite"))
  db.pragma("foreign_keys = ON")
  databases.push(db)
  return db
}

function createReadyLanes(db) {
  db.exec(`
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY,
      layout_json TEXT,
      default_harness TEXT NOT NULL DEFAULT 'shell'
    );
  `)
}

function insertLane(db, id, layout, defaultHarness = "shell") {
  db.prepare("INSERT INTO lanes (id, layout_json, default_harness) VALUES (?, ?, ?)")
    .run(id, layout === null ? null : JSON.stringify(layout), defaultHarness)
}

function terminal(id, config = {}) {
  return { kind: "pane", id, pane: "terminal", config }
}

function saved(tree) {
  return { schemaVersion: 1, tree }
}

function snapshot(binding) {
  return {
    generation: binding.generation,
    harnessId: binding.harnessId,
    resumeSessionId: binding.resumeSessionId,
    kickoffSent: binding.kickoffSent,
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("terminal binding store", () => {
  it("migrates legacy identity atomically, preserves visual state, and reopens as a semantic no-op", () => {
    const db = openDatabase()
    createReadyLanes(db)
    const legacy = {
      kind: "split",
      direction: "horizontal",
      percentage: 73.25,
      visualRevision: 7,
      first: {
        ...terminal("terminal-main", {
          harnessId: "omp",
          role: "first",
          kickoffSent: false,
          resumeSessionId: "omp-session:alpha",
          launchOnMount: true,
        }),
        presentation: { accent: "violet" },
      },
      second: { kind: "pane", id: "files-main", pane: "files", config: { folder: "src" }, pinned: true },
    }
    insertLane(db, "lane-one", legacy, "shell")

    expect(ensureTerminalContinuitySchema(db)).toBe(true)
    const firstLayoutJson = db.prepare("SELECT layout_json FROM lanes WHERE id = ?").get("lane-one").layout_json
    const migrated = JSON.parse(firstLayoutJson)
    expect(migrated).toEqual({
      schemaVersion: 1,
      tree: {
        ...legacy,
        first: {
          ...legacy.first,
          config: { role: "first" },
        },
      },
    })
    expect(db.prepare("SELECT layout_revision FROM lanes WHERE id = ?").get("lane-one")).toEqual({ layout_revision: 0 })
    const firstBinding = getTerminalBinding(db, "lane-one", "terminal-main")
    expect(firstBinding).toMatchObject({
      laneId: "lane-one",
      paneId: "terminal-main",
      harnessId: "omp",
      resumeSessionId: "omp-session:alpha",
      kickoffSent: true,
      generation: 1,
    })

    expect(ensureTerminalContinuitySchema(db)).toBe(true)
    expect(db.prepare("SELECT layout_json FROM lanes WHERE id = ?").get("lane-one").layout_json).toBe(firstLayoutJson)
    expect(getTerminalBinding(db, "lane-one", "terminal-main")).toEqual(firstBinding)

    db.close()
    const reopened = new Database(db.name)
    reopened.pragma("foreign_keys = ON")
    databases.push(reopened)
    expect(ensureTerminalContinuitySchema(reopened)).toBe(true)
    expect(reopened.prepare("SELECT layout_json FROM lanes WHERE id = ?").get("lane-one").layout_json).toBe(firstLayoutJson)
    expect(getTerminalBinding(reopened, "lane-one", "terminal-main")).toEqual(firstBinding)
  })

  it("waits for the complete lanes prerequisite and retries after a relay-first minimal schema", () => {
    const db = openDatabase()
    expect(ensureTerminalContinuitySchema(db)).toBe(false)
    db.exec("CREATE TABLE lanes (id TEXT PRIMARY KEY)")
    expect(ensureTerminalContinuitySchema(db)).toBe(false)
    db.exec("ALTER TABLE lanes ADD COLUMN layout_json TEXT")
    expect(ensureTerminalContinuitySchema(db)).toBe(false)
    db.exec("ALTER TABLE lanes ADD COLUMN default_harness TEXT NOT NULL DEFAULT 'shell'")
    expect(ensureTerminalContinuitySchema(db)).toBe(true)
    expect(db.prepare("PRAGMA table_info(lanes)").all().map((column) => column.name)).toContain("layout_revision")
  })

  it("rejects uncached initialization inside a caller transaction without leaving a cache hit", () => {
    const db = openDatabase()
    createReadyLanes(db)
    db.exec("BEGIN")
    expect(() => ensureTerminalContinuitySchema(db)).toThrow("Terminal continuity schema must be initialized before opening a transaction.")
    db.exec("ROLLBACK")
    expect(ensureTerminalContinuitySchema(db)).toBe(true)
    db.exec("BEGIN")
    expect(ensureTerminalContinuitySchema(db)).toBe(true)
    db.exec("ROLLBACK")
  })

  it("carries committed readiness across a hot module reload inside a caller transaction", async () => {
    const db = openDatabase()
    createReadyLanes(db)
    expect(ensureTerminalContinuitySchema(db)).toBe(true)
    delete db[Symbol.for("operator-engine.terminal-continuity-schema.v1")]
    const reloaded = await import("./terminal-binding-store.mjs?hmr-readiness=1")
    expect(reloaded.ensureTerminalContinuitySchema).not.toBe(ensureTerminalContinuitySchema)

    db.exec("BEGIN")
    expect(reloaded.ensureTerminalContinuitySchema(db)).toBe(true)
    db.exec("ROLLBACK")
  })

  it.each([
    ["malformed JSON", "{not-json"],
    ["duplicate pane ids", JSON.stringify(saved({
      kind: "split",
      direction: "horizontal",
      percentage: 50,
      first: terminal("terminal-main", { harnessId: "shell", role: "first" }),
      second: { kind: "pane", id: "terminal-main", pane: "files" },
    }))],
    ["invalid pane id", JSON.stringify(saved(terminal("../terminal", { harnessId: "shell" })))],
  ])("rolls back the whole migration for %s", (_name, layoutJson) => {
    const db = openDatabase()
    createReadyLanes(db)
    db.prepare("INSERT INTO lanes (id, layout_json, default_harness) VALUES ('lane-one', ?, 'shell')").run(layoutJson)

    expect(() => ensureTerminalContinuitySchema(db)).toThrow("Invalid lane layout for lane-one: pane ids must be valid and unique.")
    expect(db.prepare("PRAGMA table_info(lanes)").all().map((column) => column.name)).not.toContain("layout_revision")
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'terminal_bindings'").get()).toBeUndefined()
    expect(db.prepare("SELECT layout_json FROM lanes WHERE id = 'lane-one'").get().layout_json).toBe(layoutJson)
  })

  it("rolls back duplicate exact sessions with both claimants named", () => {
    const db = openDatabase()
    createReadyLanes(db)
    const duplicateId = "omp-session:duplicate"
    insertLane(db, "lane-a", saved(terminal("terminal-a", { harnessId: "omp", resumeSessionId: duplicateId })), "omp")
    insertLane(db, "lane-b", saved(terminal("terminal-b", { harnessId: "omp", resumeSessionId: duplicateId })), "omp")

    expect(() => ensureTerminalContinuitySchema(db)).toThrow(
      `Duplicate terminal session binding for ${duplicateId} between lane-a/terminal-a and lane-b/terminal-b.`,
    )
    expect(db.prepare("PRAGMA table_info(lanes)").all().map((column) => column.name)).not.toContain("layout_revision")
    expect(JSON.parse(db.prepare("SELECT layout_json FROM lanes WHERE id = 'lane-a'").get().layout_json).tree.config.resumeSessionId).toBe(duplicateId)
  })

  it("strips an invalid exact id instead of claiming it and enforces the durable unique index", () => {
    const db = openDatabase()
    createReadyLanes(db)
    insertLane(db, "lane-one", saved({
      kind: "split",
      direction: "horizontal",
      percentage: 50,
      first: terminal("terminal-a", { harnessId: "omp", role: "first", resumeSessionId: "bad/id" }),
      second: terminal("terminal-b", { harnessId: "omp", role: "additional" }),
    }), "omp")
    ensureTerminalContinuitySchema(db)

    expect(getTerminalBinding(db, "lane-one", "terminal-a")?.resumeSessionId).toBeNull()
    expect(JSON.parse(db.prepare("SELECT layout_json FROM lanes WHERE id = 'lane-one'").get().layout_json).tree.first.config).toEqual({ role: "first" })
    const first = getTerminalBinding(db, "lane-one", "terminal-a")
    const second = getTerminalBinding(db, "lane-one", "terminal-b")
    expect(setTerminalBindingIdentity(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      generation: first.generation,
      resumeSessionId: "omp-session:unique",
    })?.resumeSessionId).toBe("omp-session:unique")
    expect(() => setTerminalBindingIdentity(db, {
      laneId: "lane-one",
      paneId: "terminal-b",
      generation: second.generation,
      resumeSessionId: "omp-session:unique",
    })).toThrow("Duplicate terminal session binding for omp-session:unique between lane-one/terminal-a and lane-one/terminal-b.")
    expect(() => db.prepare("UPDATE terminal_bindings SET resume_session_id = ? WHERE pane_id = ?")
      .run("omp-session:unique", "terminal-b")).toThrow(/UNIQUE constraint failed/)
  })

  it("uses an epoch compare-and-swap for planned creation", () => {
    const db = openDatabase()
    createReadyLanes(db)
    insertLane(db, "lane-one", null, "omp")
    ensureTerminalContinuitySchema(db)

    expect(planTerminalBindingCreation(db, "lane-one", "terminal-a")).toEqual({
      expectedLastGeneration: null,
      nextGeneration: 1,
    })
    expect(createTerminalBinding(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      harnessId: "omp",
      expectedLastGeneration: 1,
    })).toBe("epoch-conflict")
    const created = createTerminalBinding(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      harnessId: "omp",
      expectedLastGeneration: null,
    })
    expect(created).toMatchObject({ generation: 1, harnessId: "omp", kickoffSent: false })
    expect(createTerminalBinding(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      harnessId: "shell",
      kickoffSent: true,
      expectedLastGeneration: null,
    })).toBe("epoch-conflict")
    expect(createTerminalBinding(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      harnessId: "shell",
      kickoffSent: true,
    })).toEqual(created)
  })

  it("advances only a full semantic snapshot and generation-matches identity and guidance", () => {
    const db = openDatabase()
    createReadyLanes(db)
    insertLane(db, "lane-one", null, "omp")
    ensureTerminalContinuitySchema(db)
    const created = createTerminalBinding(db, { laneId: "lane-one", paneId: "terminal-a", harnessId: "omp" })

    expect(advanceTerminalBinding(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      expected: { ...snapshot(created), kickoffSent: true },
      harnessId: "omp",
      resume: null,
    })).toBeNull()
    expect(getTerminalBinding(db, "lane-one", "terminal-a")).toEqual(created)

    const advanced = advanceTerminalBinding(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      expected: snapshot(created),
      harnessId: "omp",
      resume: null,
    })
    expect(advanced).toMatchObject({ generation: 2, resumeSessionId: null, kickoffSent: false })
    expect(markTerminalGuidanceStarted(db, { laneId: "lane-one", paneId: "terminal-a", generation: 1 })).toBeNull()
    const guided = markTerminalGuidanceStarted(db, { laneId: "lane-one", paneId: "terminal-a", generation: 2 })
    expect(guided?.kickoffSent).toBe(true)
    expect(markTerminalGuidanceStarted(db, { laneId: "lane-one", paneId: "terminal-a", generation: 2 })).toEqual(guided)
    expect(setTerminalBindingIdentity(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      generation: 1,
      resumeSessionId: "omp-session:stale",
    })).toBeNull()
    const identified = setTerminalBindingIdentity(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      generation: 2,
      resumeSessionId: "omp-session:current",
    })
    expect(identified?.resumeSessionId).toBe("omp-session:current")
    expect(() => setTerminalBindingIdentity(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      generation: 2,
      resumeSessionId: "omp-session:other",
    })).toThrow("Conflicting terminal session sources for lane-one/terminal-a.")
  })

  it("retains epochs across delete and never reuses a pane generation", () => {
    const db = openDatabase()
    createReadyLanes(db)
    insertLane(db, "lane-one", null)
    ensureTerminalContinuitySchema(db)
    const first = createTerminalBinding(db, { laneId: "lane-one", paneId: "terminal-a", harnessId: "shell" })
    const second = advanceTerminalBinding(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      expected: snapshot(first),
      harnessId: "shell",
      resume: null,
    })

    expect(deleteTerminalBinding(db, { laneId: "lane-one", paneId: "terminal-a", expectedGeneration: 1 })).toBeNull()
    expect(deleteTerminalBinding(db, { laneId: "lane-one", paneId: "terminal-a", expectedGeneration: 2 })).toEqual(second)
    expect(getTerminalBinding(db, "lane-one", "terminal-a")).toBeNull()
    expect(planTerminalBindingCreation(db, "lane-one", "terminal-a")).toEqual({ expectedLastGeneration: 2, nextGeneration: 3 })
    expect(createTerminalBinding(db, {
      laneId: "lane-one",
      paneId: "terminal-a",
      harnessId: "shell",
      expectedLastGeneration: 2,
    })).toMatchObject({ generation: 3 })
  })

  it("settles provisional rows by exact generation and sweeps only old absent bindings", () => {
    const db = openDatabase()
    createReadyLanes(db)
    insertLane(db, "lane-one", saved({ kind: "pane", id: "files-main", pane: "files" }), "omp")
    ensureTerminalContinuitySchema(db)
    const provisional = createTerminalBinding(db, { laneId: "lane-one", paneId: "terminal-hidden", harnessId: "omp" })

    expect(settleTerminalReservation(db, {
      laneId: "lane-one",
      paneId: "terminal-hidden",
      generation: provisional.generation,
    })).toMatchObject({ status: "deleted" })

    const visible = createTerminalBinding(db, { laneId: "lane-one", paneId: "terminal-visible", harnessId: "omp" })
    db.prepare("UPDATE lanes SET layout_json = ? WHERE id = ?").run(
      JSON.stringify(saved(terminal("terminal-visible", { role: "additional" }))),
      "lane-one",
    )
    expect(settleTerminalReservation(db, {
      laneId: "lane-one",
      paneId: "terminal-visible",
      generation: visible.generation,
    })).toMatchObject({ status: "consumed", binding: { generation: visible.generation } })

    const oldAbsent = createTerminalBinding(db, { laneId: "lane-one", paneId: "terminal-old", harnessId: "omp" })
    const recentAbsent = createTerminalBinding(db, { laneId: "lane-one", paneId: "terminal-recent", harnessId: "omp" })
    db.prepare("UPDATE terminal_bindings SET updated_at = ? WHERE pane_id = ?").run("2026-01-01T00:00:00.000Z", oldAbsent.paneId)
    db.prepare("UPDATE terminal_bindings SET updated_at = ? WHERE pane_id = ?").run("2026-12-01T00:00:00.000Z", recentAbsent.paneId)
    expect(deleteAbandonedTerminalBindings(db, "2026-06-01T00:00:00.000Z").map((binding) => binding.paneId)).toEqual(["terminal-old"])
    expect(listTerminalBindings(db, "lane-one").map((binding) => binding.paneId)).toEqual(["terminal-recent", "terminal-visible"])
  })
})
