import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ directory: "", source: "" }))

vi.mock("@/lib/bento-layout", () => ({ defaultLayout: () => ({ kind: "pane", id: "terminal" }) }))
vi.mock("@/lib/db", () => ({
  createLane: (input: Record<string, unknown>) => ({ id: "lane-1", ...input }),
  listLanes: () => [],
}))
vi.mock("@/lib/distributions", () => ({
  activeReviewedDistribution: async () => ({
    distribution: { id: "theme-7", starter: { id: "browser-showpiece", directoryBase: "omp-tour", entry: "index.html" } },
    resources: { starters: { "browser-showpiece": pathToFileURL(state.source) } },
  }),
}))
vi.mock("@/lib/git", () => ({ initializeGitRepository: vi.fn() }))
vi.mock("@/lib/harness-policy", () => ({ newLaneHarness: () => "omp" }))
vi.mock("@/lib/recipes", () => ({
  applyRecipe: async () => ({ rollback: vi.fn() }),
  getRecipe: async () => ({ id: "existing-folder", schemaVersion: 1, initialPanes: [] }),
}))
vi.mock("@/lib/workspace", () => ({ resolveWorkspaceDirectory: async () => state.directory }))

import { POST } from "@/app/api/lanes/route"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("lane starter creation", () => {
  it("copies the starter into a reserved suffixed folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-starter-"))
    temporary.push(root)
    state.directory = path.join(root, "workspace")
    state.source = path.join(root, "starter")
    await fs.mkdir(path.join(state.directory, "omp-tour"), { recursive: true })
    await fs.writeFile(path.join(state.directory, "omp-tour", "existing.txt"), "keep")
    await fs.mkdir(state.source)
    await fs.writeFile(path.join(state.source, "index.html"), "showpiece")

    const response = await POST(new Request("http://localhost/api/lanes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: state.directory,
        distributionId: "theme-7",
        starterId: "browser-showpiece",
        existingFolderUnchanged: true,
      }),
    }))

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ starter: { entry: "omp-tour-2/index.html" } })
    expect(await fs.readFile(path.join(state.directory, "omp-tour-2", "index.html"), "utf8")).toBe("showpiece")
    expect(await fs.readFile(path.join(state.directory, "omp-tour", "existing.txt"), "utf8")).toBe("keep")
  })
})
