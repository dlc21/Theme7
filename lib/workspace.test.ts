import fs from "node:fs/promises"
import os from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import path from "node:path"

import { canonicalWorkspaceRoots, listDirectories, resolveWorkspaceDirectory, workspacePathInternals } from "./workspace"

const originalRoot = process.env.OPERATOR_ENGINE_WORKSPACE_ROOT
const originalRoots = process.env.OPERATOR_ENGINE_WORKSPACE_ROOTS
const temporary: string[] = []

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.OPERATOR_ENGINE_WORKSPACE_ROOT
  else process.env.OPERATOR_ENGINE_WORKSPACE_ROOT = originalRoot
  if (originalRoots === undefined) delete process.env.OPERATOR_ENGINE_WORKSPACE_ROOTS
  else process.env.OPERATOR_ENGINE_WORKSPACE_ROOTS = originalRoots
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("workspace containment", () => {
  it("accepts the root and descendants", () => {
    const root = path.resolve("workspace")
    expect(workspacePathInternals.isInside(root, root)).toBe(true)
    expect(workspacePathInternals.isInside(root, path.join(root, "job"))).toBe(true)
  })

  it("rejects sibling paths", () => {
    const root = path.resolve("workspace")
    expect(workspacePathInternals.isInside(root, path.resolve("workspace-other"))).toBe(false)
    expect(workspacePathInternals.isInside(root, path.resolve("elsewhere"))).toBe(false)
  })

  it("browses and resolves each explicitly configured root independently", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-workspace-roots-"))
    temporary.push(home)
    const primary = path.join(home, "primary")
    const secondary = path.join(home, "secondary")
    await fs.mkdir(path.join(primary, "one"), { recursive: true })
    await fs.mkdir(path.join(secondary, "two"), { recursive: true })
    await fs.writeFile(path.join(secondary, "README.md"), "project", "utf8")
    process.env.OPERATOR_ENGINE_WORKSPACE_ROOT = primary
    process.env.OPERATOR_ENGINE_WORKSPACE_ROOTS = secondary

    const roots = await canonicalWorkspaceRoots()
    expect(roots).toHaveLength(2)
    const listing = await listDirectories("", roots[1].id)
    expect(listing.activeRoot.path).toBe(await fs.realpath(secondary))
    expect(listing.entries).toEqual([
      { name: "two", relativePath: "two", kind: "directory" },
      { name: "README.md", relativePath: "README.md", kind: "file" },
    ])
    await expect(resolveWorkspaceDirectory("two", roots[1].id)).resolves.toBe(await fs.realpath(path.join(secondary, "two")))
    await expect(resolveWorkspaceDirectory(path.join(primary, "one"), roots[1].id)).rejects.toThrow(/configured workspace root/)
  })
})
