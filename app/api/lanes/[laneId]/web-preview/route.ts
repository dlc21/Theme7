import { NextResponse } from "next/server"

import { getLane } from "@/lib/db"
import { validateWebPreviewEntry } from "@/lib/web-preview"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await context.params
  const lane = getLane(laneId)
  if (!lane) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  try {
    const url = new URL(request.url)
    const selected = await validateWebPreviewEntry(lane.path, url.searchParams.get("path") ?? "")
    const target = new URLSearchParams()
    const revision = url.searchParams.get("revision")
    if (revision) target.set("revision", revision)
    const query = target.size ? `?${target.toString()}` : ""
    const location = `/api/lanes/${encodeURIComponent(laneId)}/web-preview/${selected.encodedRoot}/${selected.entryFile}${query}`
    return new Response(null, { status: 307, headers: { location, "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to open Browser." }, { status: 400 })
  }
}
