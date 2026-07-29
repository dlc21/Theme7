import { NextResponse } from "next/server"

import { getLane } from "@/lib/db"
import { fingerprintWebPreviewRoot } from "@/lib/web-preview"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await context.params
  const lane = getLane(laneId)
  if (!lane) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  try {
    const entryPath = new URL(request.url).searchParams.get("path") ?? ""
    const fingerprint = await fingerprintWebPreviewRoot(lane.path, entryPath)
    return NextResponse.json({ fingerprint }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to monitor Browser source." },
      { status: 404, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }
    )
  }
}
