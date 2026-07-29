import { timingSafeEqual } from "node:crypto"
import { type NextRequest, NextResponse } from "next/server"
import { accessConfig } from "@/scripts/runtime-config-core.mjs"
import { THEME7_ACCESS_COOKIE, signAccessSession } from "@/lib/access-auth"

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid access credential." }, { status: 401 })
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid access credential." }, { status: 401 })
  }

  const bodyRecord = body as Record<string, unknown>
  const keys = Object.keys(bodyRecord)
  if (keys.length !== 1 || keys[0] !== "password") {
    return NextResponse.json({ error: "Invalid access credential." }, { status: 401 })
  }

  const inputPassword = bodyRecord.password
  if (typeof inputPassword !== "string") {
    return NextResponse.json({ error: "Invalid access credential." }, { status: 401 })
  }

  let config: { mode: "open" } | { mode: "password"; password: string; sessionSecret: string }
  try {
    config = accessConfig()
  } catch {
    return NextResponse.json({ error: "Invalid access credential." }, { status: 401 })
  }

  if (config.mode !== "password") {
    return NextResponse.json({ error: "Invalid access credential." }, { status: 401 })
  }

  const configuredPassword = config.password
  const inputBuffer = Buffer.from(inputPassword, "utf8")
  const configuredBuffer = Buffer.from(configuredPassword, "utf8")

  let isMatch = false
  if (inputBuffer.length === configuredBuffer.length) {
    isMatch = timingSafeEqual(inputBuffer, configuredBuffer)
  } else {
    const dummyBuffer = Buffer.alloc(configuredBuffer.length, 0)
    timingSafeEqual(dummyBuffer, configuredBuffer)
  }

  if (!isMatch) {
    return NextResponse.json({ error: "Invalid access credential." }, { status: 401 })
  }

  const cookieVal = await signAccessSession()
  const headers = new Headers()
  
  let isSecure = request.nextUrl.protocol === "https:"
  const xForwardedProto = request.headers.get("x-forwarded-proto")
  if (xForwardedProto) {
    const firstProto = xForwardedProto.split(",")[0].trim().toLowerCase()
    if (firstProto === "https") {
      isSecure = true
    }
  }

  let cookieString = `${THEME7_ACCESS_COOKIE}=${cookieVal}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
  if (isSecure) {
    cookieString += "; Secure"
  }
  
  headers.append("Set-Cookie", cookieString)

  return new NextResponse(null, { status: 204, headers })
}

export async function DELETE() {
  const headers = new Headers()
  headers.append("Set-Cookie", `${THEME7_ACCESS_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
  return new NextResponse(null, { status: 204, headers })
}
