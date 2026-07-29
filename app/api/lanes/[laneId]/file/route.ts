import { NextResponse } from "next/server"

import { getLane } from "@/lib/db"
import { readTextPreview } from "@/lib/files"

export const runtime = "nodejs"

export async function GET(
  request: Request,
  context: { params: Promise<{ laneId: string }> }
) {
  const { laneId } = await context.params
  const lane = getLane(laneId)
  if (!lane) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  try {
    const relativePath = new URL(request.url).searchParams.get("path") ?? ""
    return NextResponse.json(await readTextPreview(lane.path, relativePath))
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to preview file." },
      { status: 400 }
    )
  }
}
