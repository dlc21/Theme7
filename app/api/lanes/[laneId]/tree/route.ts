import { NextResponse } from "next/server"

import { getLane, touchLane } from "@/lib/db"
import { gitStatus, readFileTree } from "@/lib/files"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  context: { params: Promise<{ laneId: string }> }
) {
  const { laneId } = await context.params
  const lane = getLane(laneId)
  if (!lane) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  try {
    const [tree, git] = await Promise.all([readFileTree(lane.path), gitStatus(lane.path)])
    touchLane(laneId)
    return NextResponse.json({ tree, git })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to read lane directory." },
      { status: 400 }
    )
  }
}
