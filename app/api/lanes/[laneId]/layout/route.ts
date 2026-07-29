import { NextResponse } from "next/server"

import { getLane, saveLaneLayout } from "@/lib/db"
import { parseSavedLayout } from "@/lib/bento-layout"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await context.params
  const lane = getLane(laneId)
  if (!lane) return NextResponse.json({ error: "Lane not found." }, { status: 404, headers: { "cache-control": "no-store" } })
  return NextResponse.json({
    layout: lane.layout,
    layoutRevision: lane.layoutRevision,
    terminalBindings: lane.terminalBindings,
  }, { headers: { "cache-control": "no-store" } })
}

export async function PATCH(request: Request, context: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await context.params
  const lane = getLane(laneId)
  if (!lane) return NextResponse.json({ error: "Lane not found." }, { status: 404, headers: { "cache-control": "no-store" } })
  try {
    const body = (await request.json()) as { layout?: unknown; baseRevision?: unknown }
    if (!Number.isSafeInteger(body.baseRevision) || Number(body.baseRevision) < 0) throw new Error("Invalid layout revision.")
    const layout = parseSavedLayout(body.layout)
    if (!layout) throw new Error("Invalid saved layout.")
    const result = saveLaneLayout(laneId, layout, Number(body.baseRevision))
    if (result.status === "missing") {
      return NextResponse.json({ error: "Lane not found." }, { status: 404, headers: { "cache-control": "no-store" } })
    }
    if (result.status === "conflict") {
      return NextResponse.json({
        code: "LAYOUT_CONFLICT",
        error: "Lane layout changed in another window.",
        ...result.state,
      }, { status: 409, headers: { "cache-control": "no-store" } })
    }
    return NextResponse.json(result.state, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to save layout.",
    }, { status: 400, headers: { "cache-control": "no-store" } })
  }
}
