import fs from "node:fs/promises"
import { NextResponse } from "next/server"

import { getLane } from "@/lib/db"
import { previewResponseHeaders, resolveWebPreviewAsset } from "@/lib/web-preview"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  context: { params: Promise<{ laneId: string; encodedRoot: string; assetPath: string[] }> }
) {
  const { laneId, encodedRoot, assetPath } = await context.params
  const lane = getLane(laneId)
  if (!lane) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  try {
    const asset = await resolveWebPreviewAsset(lane.path, encodedRoot, assetPath.join("/"))
    const body = await fs.readFile(asset.absolutePath)
    return new Response(body, { status: 200, headers: previewResponseHeaders(asset.contentType) })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Preview asset is unavailable." },
      { status: 404, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }
    )
  }
}
