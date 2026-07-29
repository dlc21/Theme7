import { database } from "@/lib/db"
import { terminalLoopbackOrigin } from "../../../scripts/runtime-config-core.mjs"
import { canonicalWorkspaceRoots } from "@/lib/workspace"

export const runtime = "nodejs"

export async function GET() {
  try {
    database().prepare("SELECT 1").get()
    const workspaces = await canonicalWorkspaceRoots()
    const relay = await fetch(`${terminalLoopbackOrigin()}/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_500),
    })
    if (!relay.ok) throw new Error(`Terminal relay health failed (${relay.status}).`)
    return Response.json({ ok: true, workspaces: workspaces.length, terminal: true })
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Health check failed." },
      { status: 503 }
    )
  }
}
