import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { signAccessSession, verifyAccessSession, THEME7_ACCESS_COOKIE } from "./access-auth"

describe("access-auth", () => {

  beforeEach(() => {
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_MODE", "password")
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_PASSWORD", "fixture-password-" + "a".repeat(12))
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_SESSION_SECRET", "fixture-session-secret-" + "b".repeat(12))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("exports the correct cookie name", () => {
    expect(THEME7_ACCESS_COOKIE).toBe("theme7_access")
  })

  it("signs and verifies a session", async () => {
    const now = Date.now()
    const token = await signAccessSession(now)
    expect(token).toContain(".")
    const [payload, sig] = token.split(".")
    expect(payload).toBeDefined()
    expect(sig).toBeDefined()

    const isValid = await verifyAccessSession(token, now)
    expect(isValid).toBe(true)
  })

  it("rejects expired sessions", async () => {
    const now = Date.now()
    const token = await signAccessSession(now)
    // 43200 seconds later + 1 second
    const later = now + 43200 * 1000 + 1000
    const isValid = await verifyAccessSession(token, later)
    expect(isValid).toBe(false)
  })

  it("rejects wrong signatures", async () => {
    const now = Date.now()
    const token = await signAccessSession(now)
    const [payload] = token.split(".")
    const badSigValue = `${payload}.invalidSignature`
    const isValid = await verifyAccessSession(badSigValue, now)
    expect(isValid).toBe(false)
  })

  it("rejects wrong session secrets", async () => {
    const now = Date.now()
    const token = await signAccessSession(now)
    
    // Change secret
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_SESSION_SECRET", "fixture-session-secret-" + "c".repeat(12))
    const isValid = await verifyAccessSession(token, now)
    expect(isValid).toBe(false)
  })

  it("rejects extra fields in payload", async () => {
    const now = Date.now()
    const config = {
      mode: "password",
      sessionSecret: "fixture-session-secret-" + "b".repeat(12)
    }
    const encoder = new TextEncoder()
    const keyData = encoder.encode(config.sessionSecret)
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    
    // Add extra field
    const payloadObj = { v: 1, exp: Math.floor(now / 1000) + 100, extra: true }
    const encodedPayload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url")
    const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload))
    const sig = Buffer.from(sigBytes).toString("base64url")
    const token = `${encodedPayload}.${sig}`

    const isValid = await verifyAccessSession(token, now)
    expect(isValid).toBe(false)
  })

  it("rejects incorrect version", async () => {
    const now = Date.now()
    const config = {
      mode: "password",
      sessionSecret: "fixture-session-secret-" + "b".repeat(12)
    }
    const encoder = new TextEncoder()
    const keyData = encoder.encode(config.sessionSecret)
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    
    const payloadObj = { v: 2, exp: Math.floor(now / 1000) + 100 }
    const encodedPayload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url")
    const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload))
    const sig = Buffer.from(sigBytes).toString("base64url")
    const token = `${encodedPayload}.${sig}`

    const isValid = await verifyAccessSession(token, now)
    expect(isValid).toBe(false)
  })
})
