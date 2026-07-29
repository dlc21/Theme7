import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { activeAsset, declaredEditionAssets, editionAssetPayload, editionState, mergeEditionSurface, publicEditionFromManifest, selectEdition, validateEditionManifest } from "@/lib/editions"

let dataRoot = ""
beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-editions-"))
  process.env.OPERATOR_ENGINE_DATA_DIR = dataRoot
  delete process.env.OPERATOR_ENGINE_EDITION_DIR
  const root = path.join(dataRoot, "editions", "fixture-edition")
  await fs.mkdir(path.join(root, "assets"), { recursive: true })
  await fs.writeFile(path.join(root, "edition.json"), JSON.stringify({ schemaVersion: 1, id: "fixture-edition", name: "Fixture", description: "Fixture presentation.", brand: { productName: "Fixture Product" }, terms: { workItem: { singular: "job", plural: "jobs" } }, stylesheet: "theme.css", surfaces: { "agent-card:omp": { label: "Fixture OMP" } }, onboarding: { image: "assets/mark.svg" } }))
  await fs.writeFile(path.join(root, "theme.css"), ":root { --fixture: 1; }\n")
  await fs.writeFile(path.join(root, "assets", "mark.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"8\" height=\"8\"/></svg>\n")
})
afterEach(async () => { delete process.env.OPERATOR_ENGINE_DATA_DIR; delete process.env.OPERATOR_ENGINE_EDITION_DIR; await fs.rm(dataRoot, { recursive: true, force: true }) })

const walkthroughSteps = [
  { id: "one-job-one-box", target: "job-list", title: "One", description: "First scene." },
  { id: "open-the-right-operator", target: "operator", title: "Two", description: "Second scene." },
  { id: "bring-the-thread", target: "local-sessions", title: "Three", description: "Third scene." },
  { id: "keep-the-plot-visible", target: "workspace-state", title: "Four", description: "Fourth scene." },
]
const walkthrough = { version: "1", entryLabel: "See the walkthrough", replayLabel: "Replay walkthrough", steps: walkthroughSteps }
const manifestWithWalkthrough = { schemaVersion: 1, id: "omp-walkthrough", name: "OMP", description: "OMP walkthrough.", onboarding: { walkthrough } }

describe("Editions", () => {
  it("rejects remote, traversing, and executable presentation fields", () => {
    const base = { schemaVersion: 1, id: "bad-edition", name: "Bad", description: "Bad assets" }
    expect(() => validateEditionManifest({ ...base, stylesheet: "https://example.test/theme.css" })).toThrow("safe relative")
    expect(() => validateEditionManifest({ ...base, brand: { icon: "../icon.svg" } })).toThrow("safe relative")
    expect(() => validateEditionManifest({ ...base, script: "theme.js" })).toThrow("Unknown")
  })

  it("validates a bounded walkthrough contract", () => {
    expect(validateEditionManifest(manifestWithWalkthrough).onboarding?.walkthrough).toEqual(walkthrough)
    expect(() => validateEditionManifest({ ...manifestWithWalkthrough, onboarding: { walkthrough: { ...walkthrough, steps: [] } } })).toThrow("two to five")
    expect(() => validateEditionManifest({ ...manifestWithWalkthrough, onboarding: { walkthrough: { ...walkthrough, steps: [...walkthroughSteps, walkthroughSteps[0], walkthroughSteps[1]] } } })).toThrow("two to five")
    expect(() => validateEditionManifest({ ...manifestWithWalkthrough, onboarding: { walkthrough: { ...walkthrough, steps: [...walkthroughSteps.slice(0, 3), { ...walkthroughSteps[3], id: walkthroughSteps[0].id }] } } })).toThrow("unique")
    expect(() => validateEditionManifest({ ...manifestWithWalkthrough, onboarding: { walkthrough: { ...walkthrough, steps: [{ ...walkthroughSteps[0], id: "Bad ID" }, walkthroughSteps[1]] } } })).toThrow("lowercase kebab-case")
    expect(() => validateEditionManifest({ ...manifestWithWalkthrough, onboarding: { walkthrough: { ...walkthrough, version: "Not valid" } } })).toThrow("version is invalid")
    expect(() => validateEditionManifest({ ...manifestWithWalkthrough, onboarding: { walkthrough: { ...walkthrough, surprise: true } } })).toThrow("Unknown")
    expect(() => validateEditionManifest({ ...manifestWithWalkthrough, onboarding: { walkthrough: { ...walkthrough, steps: [{ ...walkthroughSteps[0], surprise: true }, walkthroughSteps[1]] } } })).toThrow("Unknown")
    expect(() => validateEditionManifest({ ...manifestWithWalkthrough, onboarding: { walkthrough: { ...walkthrough, steps: [{ ...walkthroughSteps[0], image: "assets/one.svg" }, walkthroughSteps[1]] } } })).toThrow("Unknown")
    expect(() => validateEditionManifest({ ...manifestWithWalkthrough, onboarding: { walkthrough: { ...walkthrough, steps: [{ ...walkthroughSteps[0], target: "body" }, walkthroughSteps[1]] } } })).toThrow("is not supported")
  })


  it("validates bounded declarative terminal showpieces", () => {
    const base = { schemaVersion: 1, id: "showpiece-edition", name: "Showpiece", description: "A reviewed showpiece." }
    const primitive = { kind: "mark", asset: "assets/mark.svg", x: 500, y: 500, width: 100, height: 100, atMs: 200, durationMs: 800, motion: "pop" }
    const terminalShowpiece = { version: 1, mode: "replace", experiences: [{ id: "package-mark", durationMs: 4000, primitives: [primitive] }] }
    expect(validateEditionManifest({ ...base, terminalShowpiece }).terminalShowpiece).toEqual(terminalShowpiece)
    const text = { kind: "text", value: "OMP // SPAWNING AGENT", variant: "loader", x: 500, y: 90, atMs: 0, durationMs: 1200, motion: "fade", tone: "accent" }
    expect(validateEditionManifest({ ...base, terminalShowpiece: { ...terminalShowpiece, experiences: [{ ...terminalShowpiece.experiences[0], primitives: [text] }] } }).terminalShowpiece?.experiences[0].primitives).toEqual([text])
    for (const invalid of [
      { ...terminalShowpiece, script: "run()" },
      { ...terminalShowpiece, version: 2 },
      { ...terminalShowpiece, mode: "random" },
      { ...terminalShowpiece, experiences: [] },
      { ...terminalShowpiece, experiences: [...terminalShowpiece.experiences, terminalShowpiece.experiences[0]] },
      { ...terminalShowpiece, experiences: [{ ...terminalShowpiece.experiences[0], durationMs: 3999 }] },
      { ...terminalShowpiece, experiences: [{ ...terminalShowpiece.experiences[0], primitives: [{ ...primitive, atMs: 3500, durationMs: 501 }] }] },
      { ...terminalShowpiece, experiences: [{ ...terminalShowpiece.experiences[0], primitives: [{ ...primitive, x: 1001 }] }] },
      { ...terminalShowpiece, experiences: [{ ...terminalShowpiece.experiences[0], primitives: [{ ...primitive, motion: "spin" }] }] },
      { ...terminalShowpiece, experiences: [{ ...terminalShowpiece.experiences[0], primitives: [{ ...primitive, render: "component" }] }] },
      { ...terminalShowpiece, experiences: [{ ...terminalShowpiece.experiences[0], primitives: [{ ...primitive, asset: "../mark.svg" }] }] },
      { ...terminalShowpiece, experiences: [{ ...terminalShowpiece.experiences[0], primitives: [{ ...primitive, asset: "https://example.test/mark.svg" }] }] },
    ]) expect(() => validateEditionManifest({ ...base, terminalShowpiece: invalid })).toThrow()
  })

  it("persists one active Edition and serves only declared assets", async () => {
    expect((await editionState()).activeId).toBe("stock")
    const state = await selectEdition("fixture-edition")
    expect(state.active?.brand).toMatchObject({ productName: "Fixture Product" })
    expect(state.active?.terms?.workItem).toEqual({ singular: "job", plural: "jobs" })
    expect(JSON.parse(await fs.readFile(path.join(dataRoot, "active-edition.json"), "utf8"))).toMatchObject({ editionId: "fixture-edition", lastEditionId: "fixture-edition" })
    expect((await activeAsset("assets/mark.svg"))?.mime).toBe("image/svg+xml")
    expect((await activeAsset("theme.css"))?.bytes.toString("utf8")).toContain("--fixture")
    expect(await activeAsset("../../package.json")).toBeNull()
    expect(mergeEditionSurface(state.active, "agent-card:omp", { label: "OMP", description: "Stock description", interaction: "default" })).toMatchObject({ label: "Fixture OMP", description: "Stock description", interaction: "default" })
  })

  it("owns projection, declared assets, MIME, and ETag contracts", async () => {
    const root = path.join(dataRoot, "editions", "fixture-edition")
    const manifest = validateEditionManifest(JSON.parse(await fs.readFile(path.join(root, "edition.json"), "utf8")))
    expect(declaredEditionAssets(manifest)).toEqual(expect.arrayContaining(["theme.css", "assets/mark.svg"]))
    expect(publicEditionFromManifest(manifest, "builtin").onboarding?.imageUrl).toBe("/api/editions/assets/assets/mark.svg")
    const payload = await editionAssetPayload(root, manifest, "assets/mark.svg", new Set([".svg"]))
    expect(payload?.mime).toBe("image/svg+xml")
    expect(payload?.etag).toMatch(/^\"[a-f0-9]{64}\"$/)
    expect(await editionAssetPayload(root, manifest, "assets/mark.svg", new Set([".png"]))).toBeNull()
  })

  it("turns an Edition off to Stock and restores the last selection", async () => {
    await selectEdition("fixture-edition")
    const stock = await selectEdition("stock")
    expect(stock).toMatchObject({ activeId: "stock", lastEditionId: "fixture-edition" })
    const restored = await selectEdition(stock.lastEditionId!)
    expect(restored).toMatchObject({ activeId: "fixture-edition", lastEditionId: "fixture-edition" })
  })

  it("falls back to Stock when the selected Edition disappears", async () => {
    await fs.writeFile(path.join(dataRoot, "active-edition.json"), JSON.stringify({ schemaVersion: 1, editionId: "gone" }))
    const state = await editionState()
    expect(state.activeId).toBe("stock")
    expect(state.error).toContain("missing")
  })

  it("makes an environment Edition authoritative and read-only", async () => {
    const root = path.join(dataRoot, "environment-edition"); await fs.mkdir(root)
    await fs.writeFile(path.join(root, "edition.json"), JSON.stringify({ schemaVersion: 1, id: "environment-edition", name: "Environment", description: "Mounted by the operator." }))
    process.env.OPERATOR_ENGINE_EDITION_DIR = root
    const state = await editionState()
    expect(state).toMatchObject({ activeId: "environment-edition", locked: true })
    await expect(selectEdition("stock")).rejects.toThrow("locked")
  })

  it("rejects remote CSS and executable SVG content", async () => {
    const root = path.join(dataRoot, "unsafe-edition"); await fs.mkdir(root)
    await fs.writeFile(path.join(root, "theme.css"), '@import "https://example.test/theme.css";')
    await fs.writeFile(path.join(root, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    await fs.writeFile(path.join(root, "edition.json"), JSON.stringify({ schemaVersion: 1, id: "unsafe-edition", name: "Unsafe", description: "Must fail.", brand: { icon: "icon.svg" }, stylesheet: "theme.css" }))
    process.env.OPERATOR_ENGINE_EDITION_DIR = root
    const state = await editionState()
    expect(state.activeId).toBe("stock")
    expect(state.error).toMatch(/CSS|SVG/)
  })
})
