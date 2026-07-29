import { describe, expect, it } from "vitest"

import { evaluateRuntimeTarget, evaluateRuntimeTargetState, normalizeRuntimeTarget } from "./runtime-target-policy.mjs"

describe("runtime target policy", () => {
  it("normalizes credential-free HTTP and HTTPS origins", () => {
    expect(normalizeRuntimeTarget("http://127.0.0.1:4700/")).toBe("http://127.0.0.1:4700")
    expect(normalizeRuntimeTarget("https://EXAMPLE.com:443/")).toBe("https://example.com")
  })

  it.each([
    ["ftp://example.com/", "Runtime target must use HTTP or HTTPS."],
    [["http://user:", "secret@example.com/"].join(""), "Runtime target must not contain credentials."],
    ["http://example.com/app", "Runtime target must use the root path."],
    ["http://example.com/?lane=one", "Runtime target must not contain a query string."],
    ["http://example.com/#pane", "Runtime target must not contain a fragment."],
  ])("rejects unsupported target %s", (target, message) => {
    expect(() => normalizeRuntimeTarget(target)).toThrow(message)
  })

  it("accepts only exact normalized target equality", () => {
    expect(evaluateRuntimeTarget({ reportedTarget: "http://127.0.0.1:4700/", attemptedTarget: "http://127.0.0.1:4700", phase: "deploy" })).toEqual([])
    expect(evaluateRuntimeTarget({ reportedTarget: "http://127.0.0.1:4700/", attemptedTarget: "http://127.0.0.1:4450/", phase: "verify" })).toEqual([
      "Runtime target mismatch: reported http://127.0.0.1:4700, verify attempted http://127.0.0.1:4450.",
    ])
  })

  it("allows missing state and requires a verified same-target binding", () => {
    expect(evaluateRuntimeTargetState(null)).toEqual([])
    expect(evaluateRuntimeTargetState({ schemaVersion: 1, reportedTarget: "http://localhost:4700", status: "bound", verifiedTarget: null })).toEqual([
      "Runtime target http://localhost:4700 is bound but not verified.",
    ])
    expect(evaluateRuntimeTargetState({ schemaVersion: 1, reportedTarget: "http://localhost:4700", status: "verified", verifiedTarget: "http://localhost:4700/" })).toEqual([])
  })
})
