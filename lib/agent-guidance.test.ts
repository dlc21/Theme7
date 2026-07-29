import { describe, expect, it } from "vitest"

import { agentSystemPrompt, CORE_AGENT_INSTRUCTIONS } from "@/lib/agent-guidance"
const runtime = { sourceCommit: "abcdef1234567890", distribution: "theme-7", role: "candidate", mode: "standalone", webPort: 4876, terminalPort: 4877, dataClass: "isolated", releaseId: "review-7", contentSha256: "a".repeat(64) } as const

describe("Operator Engine agent guidance", () => {
  it.each(["omp", "codex"] as const)("always gives %s the minimal Operator Engine capability contract", (harnessId) => {
    expect(agentSystemPrompt(harnessId)).toBe(CORE_AGENT_INSTRUCTIONS)
    expect(agentSystemPrompt(harnessId)).toContain("operator-engine open")
    expect(agentSystemPrompt(harnessId)).toContain("ask the operator in chat")
    expect(agentSystemPrompt(harnessId)).toContain("Only after an explicit affirmative reply")
    expect(agentSystemPrompt(harnessId)).toContain("as your final action because it terminates the current terminal")
    expect(agentSystemPrompt(harnessId)).toContain("Never infer approval")
    expect(agentSystemPrompt(harnessId)).toContain("use it from Shell")
  })

  it("requires agent harnesses to classify and file material outcomes without private coupling", () => {
    const prompt = agentSystemPrompt("omp")
    const privatePlanningSentinel = ["operator-engine", "private", "planning"].join("-")

    expect(prompt).toContain("Classify the operator's request before acting")
    expect(prompt).toContain("ordinary Git files")
    expect(prompt).not.toContain(privatePlanningSentinel)
    expect(agentSystemPrompt("shell")).toBeUndefined()
  })

  it("states bounded runtime identity for agents and keeps recipe guidance last", () => {
    const prompt = agentSystemPrompt("omp", "Recipe is last.", runtime)
    expect(prompt).toContain("Operator Engine candidate on web port 4876 and terminal port 4877")
    expect(prompt).toContain("standalone, theme-7, data: isolated, commit: abcdef123456, release: review-7")
    expect(prompt?.endsWith("Recipe is last.")).toBe(true)
    expect(agentSystemPrompt("shell", undefined, runtime)).toBeUndefined()
  })

  it("keeps optional recipe orientation separate and omits instructions for Shell", () => {
    expect(agentSystemPrompt("omp", "Interview the operator first.")).toBe(`${CORE_AGENT_INSTRUCTIONS}\n\nInterview the operator first.`)
    expect(agentSystemPrompt("shell", "Do not send this.")).toBeUndefined()
  })
})
