import { NextResponse } from "next/server"

import { findPane, paneIds } from "@/lib/bento-layout"
import { queueClientControlIntent } from "@/lib/client-control-intents"
import { getLane } from "@/lib/db"
import { isLoopbackControlRequest, terminalControlToken } from "@/lib/terminal-control-request"
import { verifyTerminalControlCapability } from "@/lib/terminal-ticket"

export const runtime = "nodejs"

export async function POST(request: Request) {
  if (!isLoopbackControlRequest(request)) {
    return NextResponse.json({ error: "The terminal control route is loopback-only." }, { status: 403 })
  }
  const capability = verifyTerminalControlCapability(terminalControlToken(request), "close_terminal")
  if (!capability) {
    return NextResponse.json({ error: "Terminal control capability is invalid or expired." }, { status: 403 })
  }
  const lane = getLane(capability.laneId)
  if (!lane?.layout) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
  const pane = findPane(lane.layout.tree, capability.paneId)
  if (!pane || pane.pane !== "terminal") {
    return NextResponse.json({ error: "Source terminal pane is no longer in this lane." }, { status: 400 })
  }
  const binding = lane.terminalBindings[pane.id]
  if (!binding) {
    return NextResponse.json({ error: "Terminal pane has no binding." }, { status: 500 })
  }
  if (binding.generation !== capability.generation) {
    return NextResponse.json({ error: "This terminal changed before the close command was received." }, { status: 409 })
  }
  if (paneIds(lane.layout.tree).length <= 1) {
    return NextResponse.json({ error: "This Agent Terminal is the only pane in the lane." }, { status: 409 })
  }
  const intent = queueClientControlIntent({
    kind: "close_terminal",
    laneId: lane.id,
    sourcePaneId: pane.id,
    expectedGeneration: capability.generation,
  })
  return NextResponse.json({ intentId: intent.id, expiresAt: intent.expiresAt }, { status: 202 })
}
