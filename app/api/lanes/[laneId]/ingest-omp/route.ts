import { NextResponse } from "next/server"
import { getLane } from "@/lib/db"
import { getSafeOmpInventory, ingestOmpSession } from "@/lib/omp-ingest"

type Context = {
  params: Promise<{ laneId: string }>
}

export async function GET(_request: Request, context: Context) {
  try {
    const { laneId } = await context.params
    const lane = getLane(laneId)
    if (!lane) {
      return NextResponse.json({ error: "Lane not found." }, { status: 404 })
    }

    const sessions = await getSafeOmpInventory(laneId)
    return NextResponse.json({ provider: "omp", sessions }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to load OMP session inventory.",
    }, { status: 500 })
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { laneId } = await context.params
    const lane = getLane(laneId)
    if (!lane) {
      return NextResponse.json({ error: "Lane not found." }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    const sourceSessionId = (body && typeof body === "object" && ("sourceSessionId" in body || "sessionId" in body))
      ? String((body as Record<string, unknown>).sourceSessionId ?? (body as Record<string, unknown>).sessionId ?? "").trim()
      : ""

    if (!sourceSessionId) {
      return NextResponse.json({ error: "Provide a valid sourceSessionId or sessionId." }, { status: 400 })
    }

    const result = await ingestOmpSession(laneId, sourceSessionId)
    return NextResponse.json({ ok: true, lane: result.lane, threadLink: result.threadLink }, { status: 200, headers: { "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to ingest OMP session.",
    }, { status: 400, headers: { "cache-control": "no-store" } })
  }
}
