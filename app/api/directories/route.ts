import { NextResponse } from "next/server"

import { listDirectories, makeWorkspaceDirectory } from "@/lib/workspace"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    return NextResponse.json(await listDirectories(url.searchParams.get("path") ?? "", url.searchParams.get("root") ?? undefined))
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to list directories." },
      { status: 400 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { parent?: string; name?: string; rootId?: string }
    const relativePath = await makeWorkspaceDirectory(body.parent ?? "", body.name ?? "", body.rootId)
    return NextResponse.json({ relativePath }, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create directory." },
      { status: 400 }
    )
  }
}
