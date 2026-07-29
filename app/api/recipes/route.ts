import { NextResponse } from "next/server"

import { loadRecipes } from "@/lib/recipes"

export const runtime = "nodejs"

export async function GET() {
  try {
    const recipes = (await loadRecipes()).map(({ root: _root, ...recipe }) => recipe)
    return NextResponse.json({ recipes })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load recipes." }, { status: 500 })
  }
}
