import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { proxy } from "./proxy"
import { signTerminalControlCapability } from "@/lib/terminal-ticket"
import { signSpectatorSession, THEME7_SPECTATOR_COOKIE } from "@/lib/access-auth"

describe("proxy", () => {
  beforeEach(() => {
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_MODE", "password")
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_PASSWORD", "fixture-password-correct-24-chars")
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_SESSION_SECRET", "fixture-session-secret-at-least-32-chars")
    vi.stubEnv("OPERATOR_ENGINE_TERMINAL_SECRET", "fixture-terminal-secret-at-least-32-chars")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("passes through in open mode", async () => {
    vi.stubEnv("OPERATOR_ENGINE_ACCESS_MODE", "open")
    const req = new NextRequest("http://localhost/dashboard")
    const res = await proxy(req)
    expect(res).toBeDefined()
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it("redirects page requests to /login in password mode without a cookie", async () => {
    const req = new NextRequest("http://localhost/dashboard?foo=bar")
    const res = await proxy(req)
    expect(res.status).toBe(307)
    const location = res.headers.get("location")
    expect(location).toBe("http://localhost/login?next=%2Fdashboard%3Ffoo%3Dbar")
  })

  it("returns 401 JSON for api requests in password mode without a cookie", async () => {
    const req = new NextRequest("http://localhost/api/lanes")
    const res = await proxy(req)
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toEqual({ error: "Unauthorized" })
  })

  it("allows /login, /api/auth/session, /api/health, favicon and Next assets without a cookie", async () => {
    const publicPaths = [
      "/login",
      "/api/auth/session",
      "/api/health",
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/favicon.ico"
    ]
    for (const path of publicPaths) {
      const req = new NextRequest(`http://localhost${path}`)
      const res = await proxy(req)
      expect(res.headers.get("x-middleware-next")).toBe("1")
    }
  })

  it("allows exact POST control paths with a valid control token", async () => {
    const env = {
      OPERATOR_ENGINE_TERMINAL_SECRET: "fixture-terminal-secret-at-least-32-chars",
      NODE_ENV: "test" as const
    }
    const openToken = signTerminalControlCapability(
      { laneId: "lane-1", paneId: "terminal-1", generation: 1, ttlMs: 60_000 },
      env
    )
    const closeToken = signTerminalControlCapability(
      { laneId: "lane-1", paneId: "terminal-1", generation: 1, ttlMs: 60_000 },
      env
    )

    // Web preview open
    const reqOpen = new NextRequest("http://localhost/api/control/web-preview/open", {
      method: "POST",
      headers: {
        "x-operator-engine-control-token": openToken,
      },
    })
    const resOpen = await proxy(reqOpen)
    expect(resOpen.headers.get("x-middleware-next")).toBe("1")

    // Terminal close
    const reqClose = new NextRequest("http://localhost/api/control/terminal/close", {
      method: "POST",
      headers: {
        "x-operator-engine-control-token": closeToken,
      },
    })
    const resClose = await proxy(reqClose)
    expect(resClose.headers.get("x-middleware-next")).toBe("1")
  })

  it("returns 401 on control paths with missing/invalid/expired control token", async () => {
    // Missing token
    const reqMissing = new NextRequest("http://localhost/api/control/web-preview/open", {
      method: "POST",
    })
    const resMissing = await proxy(reqMissing)
    expect(resMissing.status).toBe(401)

    // Invalid token
    const reqInvalid = new NextRequest("http://localhost/api/control/web-preview/open", {
      method: "POST",
      headers: {
        "x-operator-engine-control-token": "fixture-invalid-token",
      },
    })
    const resInvalid = await proxy(reqInvalid)
    expect(resInvalid.status).toBe(401)
  })
  it("allows GET and HEAD requests to spectator path and static assets for valid spectator session", async () => {
    const spectatorToken = await signSpectatorSession()
    
    // GET /spectator with cookie
    const reqGetCookie = new NextRequest("http://localhost/spectator", {
      headers: { cookie: `${THEME7_SPECTATOR_COOKIE}=${spectatorToken}` },
    })
    const resGetCookie = await proxy(reqGetCookie)
    expect(resGetCookie.headers.get("x-middleware-next")).toBe("1")

    // HEAD /spectator with header
    const reqHeadHeader = new NextRequest("http://localhost/spectator", {
      method: "HEAD",
      headers: { "x-spectator-token": spectatorToken },
    })
    const resHeadHeader = await proxy(reqHeadHeader)
    expect(resHeadHeader.headers.get("x-middleware-next")).toBe("1")

    // GET Next static asset with cookie
    const reqStatic = new NextRequest("http://localhost/_next/static/chunks/main.js", {
      headers: { cookie: `${THEME7_SPECTATOR_COOKIE}=${spectatorToken}` },
    })
    const resStatic = await proxy(reqStatic)
    expect(resStatic.headers.get("x-middleware-next")).toBe("1")
  })

  it("rejects spectator_token from query strings", async () => {
    const spectatorToken = await signSpectatorSession()
    const req = new NextRequest(`http://localhost/spectator?spectator_token=${spectatorToken}`)
    const res = await proxy(req)
    // Query string spectator token is ignored, so request falls back to password auth redirect
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/login")
  })

  it("returns 403 FORBIDDEN_SPECTATOR_MODE for spectator requests to unlisted paths or custom methods", async () => {
    const spectatorToken = await signSpectatorSession()
    const headers = { "x-spectator-token": spectatorToken }

    // Unlisted API paths
    const apiPaths = ["/api/health", "/api/lanes", "/api/prompt", "/dashboard", "/login"]
    for (const path of apiPaths) {
      const req = new NextRequest(`http://localhost${path}`, { headers })
      const res = await proxy(req)
      expect(res.status).toBe(403)
      const json = await res.json()
      expect(json.error).toBe("FORBIDDEN_SPECTATOR_MODE")
    }

    // Mutation and custom methods on allowed path /spectator
    const forbiddenMethods = ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "PURGE"]
    for (const method of forbiddenMethods) {
      const req = new NextRequest("http://localhost/spectator", { method, headers })
      const res = await proxy(req)
      expect(res.status).toBe(403)
      const json = await res.json()
      expect(json.error).toBe("FORBIDDEN_SPECTATOR_MODE")
    }
  })
})
