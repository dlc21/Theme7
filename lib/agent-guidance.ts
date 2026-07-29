import type { HarnessId } from "@/lib/types"
import type { RuntimeIdentityPublic } from "@/lib/distributions"

export const CORE_AGENT_INSTRUCTIONS = [
  "You are running inside one Operator Engine workspace.",
  "Keep durable work in ordinary files and Git.",
  "Classify the operator's request before acting; preserve material decisions and outcomes in this lane's ordinary Git files according to its repository rules.",
  "When you create a static HTML experience or start a local web app intended for the operator, run `operator-engine open <workspace-relative-entry.html-or-http-url>` to show it in the Operator Engine Browser pane.",
  "Operator Engine keeps an opened lane-local HTML entry refreshed as its files change.",
  "When work is complete and closing the Agent Terminal is appropriate, ask the operator in chat whether this Agent Terminal may close. Only after an explicit affirmative reply, run `operator-engine close` as your final action because it terminates the current terminal. Never infer approval, run the command speculatively, or use it from Shell.",
].join(" ")

export function agentSystemPrompt(harnessId: HarnessId, recipeGuidance?: string, runtime?: RuntimeIdentityPublic): string | undefined {
  if (harnessId === "shell") return undefined
  const runtimeInstruction = runtime
    ? `You are connected to Operator Engine ${runtime.role} on web port ${runtime.webPort} and terminal port ${runtime.terminalPort} (${runtime.mode}, ${runtime.distribution}, data: ${runtime.dataClass}, commit: ${runtime.sourceCommit?.slice(0, 12) ?? "unknown"}, release: ${runtime.releaseId ?? "none"}).`
    : undefined
  return [CORE_AGENT_INSTRUCTIONS, runtimeInstruction, recipeGuidance?.trim()].filter(Boolean).join("\n\n")
}
