import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { POST, DELETE } from "./route"
import { THEME7_ACCESS_COOKIE } from "@/lib/access-auth"

describe("api/auth/session", () => {
  beforeEach(() => {
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_MODE", "password")
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_PASSWORD", "fixture-password-correct-24-chars")
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_SESSION_SECRET", "fixture-session-secret-at-least-32-chars")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns 401 on missing password in POST body", async () => {
    const req = new NextRequest("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({}),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toEqual({ error: "Invalid access credential." })
    expect(res.headers.get("Set-Cookie")).toBeNull()
  })

  it("returns 401 on extra keys in POST body", async () => {
    const req = new NextRequest("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ password: "fixture-password-correct-24-chars", extra: 123 }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect(res.headers.get("Set-Cookie")).toBeNull()
  })

  it("returns 401 on non-string password", async () => {
    const req = new NextRequest("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ password: 12345 }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it("returns 401 on malformed JSON", async () => {
    const req = new NextRequest("http://localhost/api/auth/session", {
      method: "POST",
      body: "not-json",
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it("returns 401 on incorrect password", async () => {
    const req = new NextRequest("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ password: "fixture-wrong-password-24-chars" }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect(res.headers.get("Set-Cookie")).toBeNull()
  })

  it("returns 204 and sets cookie on correct password", async () => {
    const req = new NextRequest("http://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ password: "fixture-password-correct-24-chars" }),
    })
    const res = await POST(req)
    expect(res.status).toBe(204)
    const cookie = res.headers.get("Set-Cookie")
    expect(cookie).not.toBeNull()
    expect(cookie).toContain(`${THEME7_ACCESS_COOKIE}=`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("Max-Age=43200")
  })

  it("sets Secure attribute when request is HTTPS or has x-forwarded-proto: https", async () => {
    // Case 1: HTTPS protocol in URL
    const reqHttps = new NextRequest("https://localhost/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ password: "fixture-password-correct-24-chars" }),
    })
    const resHttps = await POST(reqHttps)
    expect(resHttps.headers.get("Set-Cookie")).toContain("Secure")

    // Case 2: HTTP protocol, but x-forwarded-proto: https
    const reqForwarded = new NextRequest("http://localhost/api/auth/session", {
      method: "POST",
      headers: {
        "x-forwarded-proto": "https, http",
      },
      body: JSON.stringify({ password: "fixture-password-correct-24-chars" }),
    })
    const resForwarded = await POST(reqForwarded)
    expect(resForwarded.headers.get("Set-Cookie")).toContain("Secure")
  })

  it("DELETE returns 204 and clears cookie", async () => {
    const res = await DELETE()
    expect(res.status).toBe(204)
    const cookie = res.headers.get("Set-Cookie")
    expect(cookie).toContain(`${THEME7_ACCESS_COOKIE}=;`)
    expect(cookie).toContain("Max-Age=0")
  })
})
