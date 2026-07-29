import { NextResponse } from "next/server"
import { editionState, selectEdition } from "@/lib/editions"

export const dynamic = "force-dynamic"
export async function GET() { return NextResponse.json(await editionState()) }
export async function PATCH(request: Request) {
  try { const body = await request.json() as { editionId?: string }; if (!body.editionId) throw new Error("Edition id is required."); return NextResponse.json(await selectEdition(body.editionId)) }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to select Edition." }, { status: 400 }) }
}
