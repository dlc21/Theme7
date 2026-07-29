import { NextResponse } from "next/server"

import { findPane } from "@/lib/bento-layout"
import { getLane } from "@/lib/db"
import { verifyTerminalControlCapability } from "@/lib/terminal-ticket"
import { queueClientControlIntent } from "@/lib/client-control-intents"
import { isBrowserUrl, normalizeBrowserUrl } from "@/lib/browser-location"
import { validateWebPreviewEntry } from "@/lib/web-preview"
import { isLoopbackControlRequest, terminalControlToken } from "@/lib/terminal-control-request"

export const runtime = "nodejs"


export async function POST(request: Request) {
  if (!isLoopbackControlRequest(request)) return NextResponse.json({ error: "The terminal control route is loopback-only." }, { status: 403 })
  try {
    const token = terminalControlToken(request)
    const capability = verifyTerminalControlCapability(token, "open_web_preview")
    if (!capability) return NextResponse.json({ error: "Terminal control capability is invalid or expired." }, { status: 403 })
    const lane = getLane(capability.laneId)
    if (!lane?.layout) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
    const pane = findPane(lane.layout.tree, capability.paneId)
    if (!pane || pane.pane !== "terminal") throw new Error("Source terminal pane is no longer in this lane.")
    const body = (await request.json()) as { location?: unknown; path?: unknown }
    const requested = typeof body.location === "string" ? body.location : body.path
    if (typeof requested !== "string") throw new Error("Provide a lane-relative .html path or an HTTP(S) URL.")
    const location = isBrowserUrl(requested)
      ? normalizeBrowserUrl(requested)
      : (await validateWebPreviewEntry(lane.path, requested)).entryPath
    const intent = queueClientControlIntent({ kind: "open_web_preview", laneId: lane.id, sourcePaneId: pane.id, location })
    return NextResponse.json({ intentId: intent.id, location: intent.location, expiresAt: intent.expiresAt })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to open Browser." }, { status: 400 })
  }
}
