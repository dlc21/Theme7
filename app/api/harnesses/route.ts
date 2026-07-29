import { NextResponse } from "next/server"

import { terminalLoopbackOrigin } from "../../../scripts/runtime-config-core.mjs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const response = await fetch(`${terminalLoopbackOrigin()}/harnesses`, { cache: "no-store", signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error("Terminal relay is unavailable.")
    return NextResponse.json(await response.json(), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to detect harnesses." }, { status: 503 })
  }
}
