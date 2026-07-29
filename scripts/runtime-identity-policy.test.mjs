import { describe, expect, it } from "vitest"
import { assertRuntimeIdentity, isRuntimeIdentity, runtimeIdentityFromEnvironment } from "./runtime-identity-policy.mjs"

const identity = { sourceCommit: "abcdef0", distribution: "stock", role: "development", mode: "hmr", webPort: 4400, terminalPort: 4401, dataClass: "isolated", releaseId: null, contentSha256: null }
describe("runtime identity policy", () => {
  it("validates the complete wire schema", () => { expect(isRuntimeIdentity(identity)).toBe(true); expect(() => assertRuntimeIdentity({ ...identity, releaseId: "bad/value" })).toThrow("Invalid runtime identity") })
  it("resolves environment values and defaults", () => expect(runtimeIdentityFromEnvironment("theme-7", { OPERATOR_ENGINE_PORT: "4500", OPERATOR_ENGINE_TERMINAL_PORT: "4501" })).toMatchObject({ distribution: "theme-7", role: "development", mode: "hmr", webPort: 4500, terminalPort: 4501 }))
  it("rejects invalid optional identity values", () => expect(() => runtimeIdentityFromEnvironment("stock", { OPERATOR_ENGINE_SOURCE_COMMIT: "bad" })).toThrow("Invalid OPERATOR_ENGINE_SOURCE_COMMIT"))
})
