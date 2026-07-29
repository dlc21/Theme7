import { NextResponse } from "next/server"

import { getLane, removeLane, updateLaneSettings } from "@/lib/db"
import { activeReviewedDistribution } from "@/lib/distributions"
import { parseLaneSettingsInput, readLaneNote, saveLaneNote } from "@/lib/lane-info"
import { terminateLaneTerminalSessions } from "@/lib/terminal-relay-control"

export const runtime = "nodejs"

type Context = { params: Promise<{ laneId: string }> }

export async function GET(_request: Request, context: Context) {
  const { laneId } = await context.params
  const lane = getLane(laneId)
  if (!lane) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  try {
    return NextResponse.json(
      { lane, note: await readLaneNote(lane.path) },
      { headers: { "cache-control": "no-store" } },
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to read lane settings." },
      { status: 400 },
    )
  }
}

export async function PATCH(request: Request, context: Context) {
  const { laneId } = await context.params
  const lane = getLane(laneId)
  if (!lane) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  try {
    const body: unknown = await request.json()
    const reviewed = await activeReviewedDistribution()
    const settings = parseLaneSettingsInput(body, reviewed?.distribution.id ?? "stock")
    const previousNote = await readLaneNote(lane.path)
    await saveLaneNote(lane.path, settings.note)
    try {
      const updated = updateLaneSettings(lane.id, settings)
      if (!updated) {
        await saveLaneNote(lane.path, previousNote)
        return NextResponse.json({ error: "Lane not found." }, { status: 404 })
      }
      return NextResponse.json({ lane: updated, note: settings.note })
    } catch (error) {
      await saveLaneNote(lane.path, previousNote)
      throw error
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to save lane settings." },
      { status: 400 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: Context
) {
  const { laneId } = await context.params
  if (!getLane(laneId)) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  try {
    await terminateLaneTerminalSessions(laneId)
    removeLane(laneId)
    return new Response(null, { status: 204 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to stop lane terminals." }, { status: 503 })
  }
}
