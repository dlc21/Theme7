import { recipePrompt } from "@/lib/recipes"
import type { HarnessId } from "@/lib/types"

export async function terminalGuidance(input: {
  recipeId: string | null
  role: "first" | "additional"
  harnessId: HarnessId
  requested: boolean
}): Promise<{ prompt?: string; source: "recipe" | null }> {
  if (!input.requested || input.harnessId === "shell") return { source: null }
  const prompt = await recipePrompt(input.recipeId, input.role)
  return prompt ? { prompt, source: "recipe" } : { source: null }
}
