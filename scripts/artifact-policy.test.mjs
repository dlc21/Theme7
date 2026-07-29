import { describe, expect, it } from "vitest"
import { createArtifactManifest, validateArtifactManifest } from "./artifact-policy.mjs"

const base = { schemaVersion: 1, sourceCommit: "abcdef0", distribution: "stock", contentSha256: "", theme7Sha256: null, builtAt: "2026-01-01T00:00:00.000Z", platform: "win32", architecture: "x64", node: "v24", checks: {} }
describe("artifact policy", () => {
  it("creates a pre-hash manifest", () => expect(createArtifactManifest(base)).toEqual(base))
  it("requires a content hash for packaged artifacts", () => { expect(() => validateArtifactManifest(base, { packaged: true })).toThrow("Invalid standalone artifact.json"); expect(validateArtifactManifest({ ...base, contentSha256: "a".repeat(64) }, { packaged: true })).toBeTruthy() })
  it("rejects extra schema keys", () => expect(() => createArtifactManifest({ ...base, extra: true })).not.toThrow())
})
