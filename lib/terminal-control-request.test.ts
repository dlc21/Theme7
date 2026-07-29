import { describe, expect, it } from "vitest"

import { isLoopbackControlRequest, terminalControlToken } from "@/lib/terminal-control-request"

function request(headers: HeadersInit): Request {
  return new Request("http://placeholder/api/control", { headers })
}

describe("terminal control requests", () => {
  it.each([
    [{ host: "127.0.0.1:4400" }, true],
    [{ host: "localhost:4400" }, true],
    [{ host: "[::1]:4400" }, true],
    [{ host: "example.test:4400" }, false],
    [{ host: "not a host" }, false],
  ] as const)("classifies the request host %j as loopback=%s", (headers, expected) => {
    expect(isLoopbackControlRequest(request(headers))).toBe(expected)
  })

  it("uses the first forwarded host for the loopback boundary", () => {
    expect(isLoopbackControlRequest(request({ host: "example.test", "x-forwarded-host": "127.0.0.1:4400, example.test" }))).toBe(true)
    expect(isLoopbackControlRequest(request({ host: "127.0.0.1:4400", "x-forwarded-host": "example.test" }))).toBe(false)
  })

  it("accepts only the canonical scoped token", () => {
    expect(terminalControlToken(request({ "x-operator-engine-control-token": "fixture-canonical-token" }))).toBe("fixture-canonical-token")
    expect(terminalControlToken(request({}))).toBe("")
  })
})
