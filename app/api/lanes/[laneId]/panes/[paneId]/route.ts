import { NextResponse } from "next/server"

import { closeTerminalPane } from "@/lib/db"
import { terminateTerminalSession } from "@/lib/terminal-relay-control"

export const runtime = "nodejs"

export async function DELETE(request: Request, context: { params: Promise<{ laneId: string; paneId: string }> }) {
  try {
    const { laneId, paneId } = await context.params
    const body = await request.json() as { baseRevision?: unknown; expectedGeneration?: unknown }
    if (!Number.isSafeInteger(body.baseRevision) || Number(body.baseRevision) < 0) {
      return NextResponse.json({ error: "Invalid layout revision." }, { status: 400, headers: { "cache-control": "no-store" } })
    }
    if (!Number.isSafeInteger(body.expectedGeneration) || Number(body.expectedGeneration) < 1) {
      return NextResponse.json({ error: "Invalid terminal binding generation." }, { status: 400, headers: { "cache-control": "no-store" } })
    }
    const result = closeTerminalPane({
      laneId,
      paneId,
      baseRevision: Number(body.baseRevision),
      expectedGeneration: Number(body.expectedGeneration),
    })
    if (result.status === "layout-conflict") {
      return NextResponse.json({
        code: "LAYOUT_CONFLICT",
        error: "Lane layout changed in another window.",
        ...result.state,
      }, { status: 409, headers: { "cache-control": "no-store" } })
    }
    if (result.status === "binding-conflict") {
      return NextResponse.json({
        code: "TERMINAL_BINDING_CHANGED",
        error: "This terminal changed in another window.",
        ...result.state,
      }, { status: 409, headers: { "cache-control": "no-store" } })
    }
    if (result.status === "missing-lane") {
      return NextResponse.json({ error: "Lane not found." }, { status: 404, headers: { "cache-control": "no-store" } })
    }
    if (result.status === "missing-pane") {
      return NextResponse.json({ error: "Terminal pane not found." }, { status: 404, headers: { "cache-control": "no-store" } })
    }
    if (result.status === "invalid-last-pane") {
      return NextResponse.json({ code: "INVALID_LAST_PANE", error: "This Agent Terminal is the only pane in the lane." }, { status: 400, headers: { "cache-control": "no-store" } })
    }
    if (result.status === "missing-binding") {
      return NextResponse.json({
        code: "TERMINAL_BINDING_INVARIANT",
        error: "Terminal pane has no binding.",
      }, { status: 500, headers: { "cache-control": "no-store" } })
    }

    let terminated = false
    let cleanupError: string | undefined
    try {
      terminated = await terminateTerminalSession(laneId, paneId, result.deletedGeneration) === 1
    } catch {
      cleanupError = "Terminal pane closed, but its detached process could not be stopped."
    }
    return NextResponse.json({
      ...result.state,
      terminated,
      ...(cleanupError ? { cleanupError } : {}),
    }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to close terminal pane.",
    }, { status: 400, headers: { "cache-control": "no-store" } })
  }
}
