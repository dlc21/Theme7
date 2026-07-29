import { NextResponse } from "next/server"

import { getLane } from "@/lib/db"
import { acknowledgeClientControlIntent, listClientControlIntents } from "@/lib/client-control-intents"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await context.params
  if (!getLane(laneId)) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  return NextResponse.json({ intents: listClientControlIntents(laneId) }, { headers: { "cache-control": "no-store" } })
}

export async function DELETE(request: Request, context: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await context.params
  if (!getLane(laneId)) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  const intentId = new URL(request.url).searchParams.get("intentId") ?? ""
  return NextResponse.json({ acknowledged: acknowledgeClientControlIntent(laneId, intentId) })
}
