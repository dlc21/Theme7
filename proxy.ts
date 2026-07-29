import { type NextRequest, NextResponse } from "next/server"
import { accessConfig } from "./scripts/runtime-config-core.mjs"
import { THEME7_ACCESS_COOKIE, THEME7_SPECTATOR_COOKIE, verifyAccessSession, verifySpectatorSession } from "./lib/access-auth"
import { verifyTerminalControlCapability } from "./lib/terminal-ticket"

export async function proxy(request: NextRequest) {
  let config: { mode: "open" } | { mode: "password"; password: string; sessionSecret: string }
  try {
    config = accessConfig()
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const pathname = request.nextUrl.pathname
  const method = request.method

  // 1. Static/image assets, favicon and public endpoints bypass definitions
  const isStatic = pathname.startsWith("/_next/") || pathname === "/favicon.ico"
  const isPublicAuthPath = pathname === "/login" || pathname === "/api/auth/session" || pathname === "/api/health"

  // 2. Spectator Token / Cookie Validation & Positive Allowlist
  const spectatorCookie = request.cookies.get(THEME7_SPECTATOR_COOKIE)?.value
  const spectatorToken = spectatorCookie || request.headers.get("x-spectator-token")
  const isSpectator = spectatorToken ? await verifySpectatorSession(spectatorToken) : false

  if (isSpectator) {
    const isAllowedSpectatorPath = pathname === "/spectator" || isStatic
    const isAllowedSpectatorMethod = method === "GET" || method === "HEAD"
    if (isAllowedSpectatorPath && isAllowedSpectatorMethod) {
      return NextResponse.next()
    }
    return NextResponse.json(
      { error: "FORBIDDEN_SPECTATOR_MODE", message: "Input and session mutations are strictly disabled on spectator broadcast endpoints." },
      { status: 403 }
    )
  }

  if (config.mode === "open") {
    return NextResponse.next()
  }

  if (isStatic || isPublicAuthPath) {
    return NextResponse.next()
  }

  // 3. Exact PTY control calls bypass with valid control token
  if (method === "POST") {
    let intent: "open_web_preview" | "close_terminal" | null = null
    if (pathname === "/api/control/web-preview/open") {
      intent = "open_web_preview"
    } else if (pathname === "/api/control/terminal/close") {
      intent = "close_terminal"
    }

    if (intent) {
      const token = request.headers.get("x-operator-engine-control-token") || ""
      const capability = verifyTerminalControlCapability(token, intent)
      if (capability) {
        return NextResponse.next()
      }
    }
  }

  // 4. Cookie validation
  const cookieValue = request.cookies.get(THEME7_ACCESS_COOKIE)?.value
  const isValidCookie = await verifyAccessSession(cookieValue)

  if (isValidCookie) {
    return NextResponse.next()
  }

  // 5. Denied: api -> JSON 401, pages -> redirect to login with next
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const url = request.nextUrl.clone()
  const relativePath = url.pathname + url.search
  const safeNext = relativePath.startsWith("/") && !relativePath.startsWith("//") && !relativePath.startsWith("\\")
    ? relativePath
    : "/"
  
  const loginUrl = new URL("/login", request.url)
  loginUrl.searchParams.set("next", safeNext)
  return NextResponse.redirect(loginUrl)
}
