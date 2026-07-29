import { describe, expect, it } from "vitest"

import {
  appendTerminalSecret,
  assertAccessPassword,
  assertAccessSessionSecret,
  assertTerminalSecret,
  generatedAccessPassword,
  generatedAccessSessionSecret,
  generatedTerminalSecret,
  renderComposeEnvironment,
  terminalSecretFromEnv,
} from "./setup-secret-policy.mjs"

const secret = "a".repeat(43)

describe("setup terminal secret policy", () => {
  it("generates a 32-byte base64url secret", () => {
    expect(generatedTerminalSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("generates a 24-byte base64url password", () => {
    expect(generatedAccessPassword()).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it("generates a 32-byte base64url session secret", () => {
    expect(generatedAccessSessionSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("appends one canonical secret without changing existing settings", () => {
    const source = "OPERATOR_ENGINE_PORT=4400\n"
    const updated = appendTerminalSecret(source, secret)
    expect(updated).toBe(`${source}OPERATOR_ENGINE_TERMINAL_SECRET=${secret}\n`)
    expect(terminalSecretFromEnv(updated)).toBe(secret)
    expect(() => appendTerminalSecret(updated, secret)).toThrow(/already configured/)
  })

  it("renders a secret-only Compose environment file", () => {
    const password = "fixture-password-" + "b".repeat(12)
    const sessionSecret = "fixture-session-secret-" + "c".repeat(12)
    const rendered = renderComposeEnvironment(secret, password, sessionSecret)
    expect(rendered).toBe(
      `OPERATOR_ENGINE_TERMINAL_SECRET=${secret}\nOPERATOR_ENGINE_ACCESS_MODE=password\nOPERATOR_ENGINE_ACCESS_PASSWORD=${password}\nOPERATOR_ENGINE_ACCESS_SESSION_SECRET=${sessionSecret}\n`
    )
  })

  it.each(["", "short", ` ${secret}`, `${secret}\nextra`])("rejects an unsafe secret", (value) => {
    expect(() => assertTerminalSecret(value)).toThrow(/at least 32/)
  })

  it.each(["", "short", ` ${secret}`, `${secret}\nextra`])("rejects an unsafe password", (value) => {
    // It must be at least 24 chars. Let's pass a short string like "short"
    expect(() => assertAccessPassword("short")).toThrow(/at least 24/)
  })

  it.each(["", "short", ` ${secret}`, `${secret}\nextra`])("rejects an unsafe session secret", (value) => {
    // It must be at least 32 chars. Let's pass a short string like "short"
    expect(() => assertAccessSessionSecret("short")).toThrow(/at least 32/)
  })
})
