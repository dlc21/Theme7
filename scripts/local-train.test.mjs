import { createRequire } from "node:module"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createArtifactManifest } from "./artifact-policy.mjs"

import {
  STAGES,
  commandMatches,
  createProfiles,
  isSelfTerminatingDailyAction,
  fetchStageHealth,
  migrateReviewData,
  packageStandalone,
  rebindRuntimeProfile,
  stateRecordMatches,
  waitForStageHealth,
} from "./local-train-core.mjs"
import { RUNTIME_FILES } from "./runtime-files-policy.mjs"

const require = createRequire(import.meta.url)
const Database = require("better-sqlite3")
const temporary = []

async function temp() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "operator-engine-train-"))
  temporary.push(directory)
  return directory
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(temporary.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })))
})

describe("local daily-driver train", () => {
  it("creates isolated profiles with canonical ports and distinct secrets", async () => {
    const root = await temp()
    const repository = path.join(root, "repo")
    const profiles = createProfiles({
      trainRoot: path.join(root, "train"),
      repositoryRoot: repository,
      sourceEnvironment: {
        OPERATOR_ENGINE_WORKSPACE_ROOTS: path.join(root, "projects"),
        OPERATOR_ENGINE_OMP_PREWARM: "1",
        OPERATOR_ENGINE_OMP_PREWARM_TTL_MS: "60000",
      },
    })
    expect(STAGES.daily).toEqual({ webPort: 4600, terminalPort: 4601 })
    expect(profiles.daily.OPERATOR_ENGINE_PORT).toBe(String(STAGES.daily.webPort))
    expect(profiles.candidate.OPERATOR_ENGINE_PORT).toBe(String(STAGES.candidate.webPort))
    expect(profiles.workshop.OPERATOR_ENGINE_PORT).toBe(String(STAGES.workshop.webPort))
    expect(new Set(Object.values(profiles).map((profile) => profile.OPERATOR_ENGINE_DB_PATH)).size).toBe(3)
    expect(new Set(Object.values(profiles).map((profile) => profile.OPERATOR_ENGINE_TERMINAL_SECRET)).size).toBe(3)
    expect(profiles.workshop.OPERATOR_ENGINE_WORKSPACE_ROOTS).toContain(repository)
    expect(profiles.workshop.OPERATOR_ENGINE_STANDALONE).toBe("0")
    expect(profiles.workshop.OPERATOR_ENGINE_NEXT_DIST_DIR).toBe(".next-workshop")
    expect(profiles.candidate.OPERATOR_ENGINE_NEXT_DIST_DIR).toBe(".next")
    expect(profiles.candidate.OPERATOR_ENGINE_STANDALONE).toBe("1")
    expect(Object.keys(profiles.workshop).every((key) => key.startsWith("OPERATOR_ENGINE_"))).toBe(true)
    expect(JSON.stringify({ ...profiles, redacted: true })).not.toContain("undefined")
    for (const profile of Object.values(profiles)) {
      expect(profile.OPERATOR_ENGINE_OMP_PREWARM).toBe("1")
      expect(profile.OPERATOR_ENGINE_OMP_PREWARM_TTL_MS).toBe("60000")
    }

    const absentProfiles = createProfiles({
      trainRoot: path.join(root, "absent-train"),
      repositoryRoot: repository,
    })
    const disabledProfiles = createProfiles({
      trainRoot: path.join(root, "disabled-train"),
      repositoryRoot: repository,
      sourceEnvironment: {
        OPERATOR_ENGINE_OMP_PREWARM: "true",
        OPERATOR_ENGINE_OMP_PREWARM_TTL_MS: "120000",
      },
    })
    for (const profile of [...Object.values(absentProfiles), ...Object.values(disabledProfiles)]) {
      expect(profile).not.toHaveProperty("OPERATOR_ENGINE_OMP_PREWARM")
      expect(profile).not.toHaveProperty("OPERATOR_ENGINE_OMP_PREWARM_TTL_MS")
    }
  })
  it("moves a durable profile without changing its state locations or secret", () => {
    const current = {
      OPERATOR_ENGINE_PORT: "4400",
      OPERATOR_ENGINE_TERMINAL_PORT: "4401",
      OPERATOR_ENGINE_DATA_DIR: "durable-data",
      OPERATOR_ENGINE_DB_PATH: "durable-data/operator-engine.sqlite",
      OPERATOR_ENGINE_WORKSPACE_ROOT: "durable-data/workspace",
      OPERATOR_ENGINE_TERMINAL_SECRET: "fixture-keep-this-secret",
    }
    expect(rebindRuntimeProfile(current, "4600")).toEqual({
      ...current,
      OPERATOR_ENGINE_PORT: "4600",
      OPERATOR_ENGINE_TERMINAL_PORT: "4601",
    })
    expect(() => rebindRuntimeProfile(current, "65535")).toThrow(/1 through 65534/)
    expect(() => rebindRuntimeProfile(current, "not-a-port")).toThrow(/integer/)
  })

  it("rejects a stage whose API is healthy but application route fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => ({
      ok: !String(url).endsWith(":4500"),
    })))
    const health = await fetchStageHealth({
      OPERATOR_ENGINE_PORT: "4500",
      OPERATOR_ENGINE_TERMINAL_PORT: "4501",
    })
    expect(health).toEqual({ web: true, app: false, relay: true, healthy: false })
    await expect(waitForStageHealth({
      OPERATOR_ENGINE_PORT: "4500",
      OPERATOR_ENGINE_TERMINAL_PORT: "4501",
    }, 1)).resolves.toBe(false)
  })


  it("blocks actions that would terminate their own Daily terminal", () => {
    const daily = { OPERATOR_ENGINE_PORT: "4600", OPERATOR_ENGINE_TERMINAL_PORT: "4601" }
    expect(isSelfTerminatingDailyAction("promote", undefined, daily)).toBe(true)
    expect(isSelfTerminatingDailyAction("rollback", undefined, daily)).toBe(true)
    expect(isSelfTerminatingDailyAction("daily", "stop", daily)).toBe(true)
    expect(isSelfTerminatingDailyAction("daily", "restart", daily)).toBe(true)
    expect(isSelfTerminatingDailyAction("daily", "move", daily)).toBe(true)
    expect(isSelfTerminatingDailyAction("candidate", "stop", daily)).toBe(false)
    expect(isSelfTerminatingDailyAction("promote", undefined, { OPERATOR_ENGINE_PORT: "4500", OPERATOR_ENGINE_TERMINAL_PORT: "4501" })).toBe(false)
    expect(isSelfTerminatingDailyAction("promote", undefined, {
      OPERATOR_ENGINE_PORT: "4700",
      OPERATOR_ENGINE_TERMINAL_PORT: "4701",
      OPERATOR_ENGINE_RUNTIME_ROLE: "promoted",
      OPERATOR_ENGINE_DATA_CLASS: "durable",
    })).toBe(true)
  })

  it("preserves an existing secret when profiles are regenerated", async () => {
    const root = await temp()
    const profiles = createProfiles({
      trainRoot: path.join(root, "train"),
      repositoryRoot: path.join(root, "repo"),
      existing: { daily: { OPERATOR_ENGINE_TERMINAL_SECRET: "fixture-keep-me" } },
    })
    expect(profiles.daily.OPERATOR_ENGINE_TERMINAL_SECRET).toBe("fixture-keep-me")
    expect(profiles.workshop.OPERATOR_ENGINE_TERMINAL_SECRET).not.toBe("fixture-keep-me")
  })

  it("copies review data, rewrites contained lane paths, and preserves external paths", async () => {
    const root = await temp()
    const sourceData = path.join(root, "review")
    const sourceWorkspace = path.join(sourceData, "workspace")
    const containedLane = path.join(sourceWorkspace, "lane-one")
    const externalLane = path.join(root, "external-lane")
    await Promise.all([fsp.mkdir(containedLane, { recursive: true }), fsp.mkdir(externalLane, { recursive: true })])
    await fsp.writeFile(path.join(containedLane, "README.md"), "ordinary file")
    await fsp.mkdir(path.join(sourceData, "operator-notes"), { recursive: true })
    await fsp.writeFile(path.join(sourceData, "operator-notes", "note.txt"), "keep this")
    const sourceDatabase = path.join(sourceData, "client.sqlite")
    const db = new Database(sourceDatabase)
    db.exec("CREATE TABLE lanes (id TEXT PRIMARY KEY, name TEXT, path TEXT, created_at TEXT, last_opened_at TEXT, layout_json TEXT, recipe_id TEXT, recipe_version INTEGER, default_harness TEXT, thread_links_json TEXT)")
    const insert = db.prepare("INSERT INTO lanes VALUES (?, ?, ?, '', '', ?, ?, ?, ?, ?)")
    insert.run("one", "One", containedLane, '{"schemaVersion":1}', "blank", 1, "shell", "[]")
    insert.run("two", "Two", externalLane, null, null, null, "omp", '[{"schemaVersion":1}]')
    db.close()

    const destinationData = path.join(root, "train", "daily")
    await fsp.mkdir(path.join(destinationData, "workspace"), { recursive: true })
    const result = await migrateReviewData({ Database, sourceData, sourceDatabase, sourceWorkspace, destinationData })
    expect(result.laneCount).toBe(2)
    const migrated = new Database(path.join(destinationData, "theme7.sqlite"), { readonly: true })
    const rows = migrated.prepare("SELECT id, path, layout_json, thread_links_json FROM lanes ORDER BY id").all()
    migrated.close()
    expect(rows[0].path).toBe(path.join(destinationData, "workspace", "lane-one"))
    expect(rows[0].layout_json).toBe('{"schemaVersion":1}')
    expect(rows[1].path).toBe(externalLane)
    expect(rows[1].thread_links_json).toBe('[{"schemaVersion":1}]')
    expect(fs.existsSync(path.join(destinationData, "workspace", "lane-one", "README.md"))).toBe(true)
    expect(fs.existsSync(path.join(destinationData, "operator-notes", "note.txt"))).toBe(true)
    expect(fs.existsSync(sourceDatabase)).toBe(true)
  })

  it("removes a failed migration without creating the Daily root", async () => {
    const root = await temp()
    const sourceData = path.join(root, "review")
    const sourceWorkspace = path.join(sourceData, "workspace")
    await fsp.mkdir(sourceWorkspace, { recursive: true })
    const sourceDatabase = path.join(sourceData, "client.sqlite")
    const db = new Database(sourceDatabase)
    db.exec("CREATE TABLE lanes (id TEXT PRIMARY KEY, path TEXT)")
    db.prepare("INSERT INTO lanes VALUES (?, ?)").run("missing", path.join(sourceWorkspace, "missing"))
    db.close()
    const destinationData = path.join(root, "train", "daily")
    await expect(migrateReviewData({ Database, sourceData, sourceDatabase, sourceWorkspace, destinationData })).rejects.toThrow(/missing/i)
    expect(fs.existsSync(destinationData)).toBe(false)
  })

  it("packages the standalone server and the complete terminal helper boundary", async () => {
    const root = await temp()
    const build = path.join(root, "build")
    const destination = path.join(root, "release")
    const distName = ".next-package-fixture"
    vi.stubEnv("OPERATOR_ENGINE_PACKAGE_NEXT_DIST_DIR", distName)
    for (const file of [
      ...RUNTIME_FILES,
      `${distName}/standalone/server.js`,
      `${distName}/standalone/${distName}/BUILD_ID`,
      "node_modules/ws/package.json",
      "node_modules/better-sqlite3/package.json",
      "node_modules/@lydell/node-pty/package.json",
      `node_modules/@lydell/node-pty-${process.platform}-${process.arch}/package.json`,
      "recipes/builtin/example.json",
      "editions/builtin/stock.json",
    ]) {
      await fsp.mkdir(path.dirname(path.join(build, file)), { recursive: true })
      await fsp.writeFile(path.join(build, file), file)
    }
    const manifest = createArtifactManifest({ schemaVersion: 1, sourceCommit: "abcdef0", distribution: "stock", theme7Sha256: null, platform: process.platform, architecture: process.arch, node: process.version, builtAt: new Date().toISOString(), contentSha256: "", checks: {} })
    await packageStandalone({ buildRoot: build, destination, manifest })
    expect(fs.existsSync(path.join(destination, "server.js"))).toBe(true)
    expect(fs.existsSync(path.join(destination, ".next"))).toBe(true)
    expect(fs.existsSync(path.join(destination, distName))).toBe(false)
    expect(fs.existsSync(path.join(destination, "scripts", "terminal-relay.mjs"))).toBe(true)
    expect(fs.existsSync(path.join(destination, "scripts", "terminal-binding-store.mjs"))).toBe(true)
    expect(fs.existsSync(path.join(destination, "scripts", "terminal-control-capability.mjs"))).toBe(true)
    expect(fs.existsSync(path.join(destination, "scripts", "distribution-adapters.mjs"))).toBe(true)
    for (const notice of ["LICENSE", "README.md", "SECURITY.md", ".env.example"]) expect(fs.existsSync(path.join(destination, notice))).toBe(true)
    expect(fs.existsSync(path.join(destination, "node_modules", "theme-7"))).toBe(false)
    expect(JSON.parse(await fsp.readFile(path.join(destination, "artifact.json"), "utf8")).contentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(await fsp.readFile(path.join(destination, "artifact.json"), "utf8")).sourceCommit).toBe("abcdef0")
    await expect(packageStandalone({ buildRoot: build, destination, manifest })).rejects.toThrow(/already exists/i)
  }, 20_000)

  it("matches only the fully qualified recorded supervisor entry", () => {
    const expected = path.resolve("repo", "scripts", "run.mjs")
    expect(commandMatches(`node \"${expected}\" dev`, expected)).toBe(true)
    expect(commandMatches("node C:/somewhere-else/scripts/run.mjs dev", expected)).toBe(false)
  })

  it("rejects ownership records with changed ports, sources, or artifacts", async () => {
    const root = await temp()
    const repository = path.join(root, "repo")
    const train = path.join(root, "train")
    const release = path.join(train, "releases", "release-one")
    const profile = { OPERATOR_ENGINE_PORT: "4450", OPERATOR_ENGINE_TERMINAL_PORT: "4451" }
    const specification = { entry: path.join(release, "scripts", "run.mjs"), cwd: release, release: { id: "release-one" } }
    const state = { stage: "candidate", entry: specification.entry, cwd: release, releaseId: "release-one", webPort: 4450, terminalPort: 4451 }
    const matches = (candidate) => stateRecordMatches({ stage: "candidate", state: candidate, profile, repositoryRoot: repository, trainRoot: train, specification })
    expect(matches(state)).toBe(true)
    expect(matches({ ...state, webPort: 4400 })).toBe(false)
    expect(matches({ ...state, cwd: path.join(root, "foreign"), entry: path.join(root, "foreign", "scripts", "run.mjs") })).toBe(false)
    expect(matches({ ...state, releaseId: "another-release" })).toBe(false)
  })
})
