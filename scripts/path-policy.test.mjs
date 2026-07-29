import path from "node:path"
import { describe, expect, it } from "vitest"
import { isPathInside, relativePortablePath } from "./path-policy.mjs"

describe("lexical path policy", () => {
  it("accepts a root and child", () => { const root = path.resolve("root"); expect(isPathInside(root, root)).toBe(true); expect(isPathInside(root, path.join(root, "child"))).toBe(true) })
  it("rejects sibling prefixes and parent escapes", () => { const root = path.resolve("root"); expect(isPathInside(root, path.resolve("root-other"))).toBe(false); expect(isPathInside(root, path.join(root, "..", "outside"))).toBe(false) })
  it("emits portable relative paths", () => expect(relativePortablePath(path.resolve("root"), path.resolve("root", "a", "b"))).toBe("a/b"))
})
