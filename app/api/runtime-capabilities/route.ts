import { NextResponse } from "next/server"

import { runtimeCapabilities } from "@/lib/distributions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json(await runtimeCapabilities(), { headers: { "Cache-Control": "no-store" } })
}
