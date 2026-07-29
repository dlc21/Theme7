import { describe, expect, it } from "vitest"

import { parseWorkspaceRoots } from "./workspace-roots.mjs"

describe("workspace-root environment parsing", () => {
  it("keeps the primary root and appends platform-delimited roots", () => {
    const roots = parseWorkspaceRoots("C:\\Primary", "C:\\Source;D:\\Projects", ";")
    expect(roots).toHaveLength(3)
    expect(roots[0]).toMatch(/Primary$/i)
    expect(roots[2]).toMatch(/Projects$/i)
  })

  it("removes repeated roots without dropping their first position", () => {
    const roots = parseWorkspaceRoots("/workspace", "/workspace:/projects", ":")
    expect(roots).toHaveLength(2)
    expect(roots[0]).toMatch(/workspace$/)
    expect(roots[1]).toMatch(/projects$/)
  })
})
