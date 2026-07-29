import { NextResponse } from "next/server"

import { agentSystemPrompt } from "@/lib/agent-guidance"
import { findPane, terminalPaneConfig } from "@/lib/bento-layout"
import { database, getLane } from "@/lib/db"
import { activeReviewedDistribution, runtimeIdentity } from "@/lib/distributions"
import { canStartNewHarness } from "@/lib/harness-policy"
import { signTerminalTicket, validateTerminalIdentity } from "@/lib/terminal-ticket"
import { terminalGuidance } from "@/lib/terminal-guidance"
import type { HarnessId, TerminalBinding, TerminalTicketRequest } from "@/lib/types"
import { advanceTerminalBinding } from "../../../scripts/terminal-binding-store.mjs"

export const runtime = "nodejs"

function bindingChanged(binding: TerminalBinding) {
  return NextResponse.json({
    code: "TERMINAL_BINDING_CHANGED",
    error: "This terminal changed in another window.",
    binding,
  }, { status: 409, headers: { "cache-control": "no-store" } })
}

function exactResumeResponse(
  laneId: string,
  paneId: string,
  binding: TerminalBinding,
  identity: ReturnType<typeof runtimeIdentity>,
) {
  const ticket = signTerminalTicket({
    laneId,
    paneId,
    harnessId: "omp",
    generation: binding.generation,
    mode: "resume-exact",
    runtimeIdentity: identity,
    resumeSessionId: binding.resumeSessionId ?? undefined,
  })
  return NextResponse.json({
    ticket,
    binding,
    mode: "resume-exact",
    guidanceIncluded: false,
    guidanceSource: "none",
  }, { headers: { "cache-control": "no-store" } })
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Partial<TerminalTicketRequest> & Record<string, unknown>
    const laneId = typeof body.laneId === "string" ? body.laneId.trim() : ""
    const paneId = typeof body.paneId === "string" ? body.paneId.trim() : ""
    validateTerminalIdentity(laneId, paneId)
    if (body.action !== "attach" && body.action !== "start" && body.action !== "new-session"
        && body.action !== "resume-bound" && body.action !== "choose-omp-session") {
      throw new Error("Choose a valid terminal action.")
    }

    const lane = getLane(laneId)
    if (!lane?.layout) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
    const pane = findPane(lane.layout.tree, paneId)
    if (!pane || pane.pane !== "terminal") throw new Error("Terminal pane not found in this lane.")
    const binding = lane.terminalBindings[paneId]
    if (!binding) {
      return NextResponse.json({
        code: "TERMINAL_BINDING_INVARIANT",
        error: "Terminal pane has no binding.",
      }, { status: 500, headers: { "cache-control": "no-store" } })
    }

    const reviewed = await activeReviewedDistribution()
    const distributionId = reviewed?.distribution.id ?? "stock"
    const runtimeIdentityValue = runtimeIdentity(distributionId)

    if (body.action === "attach") {
      if (!canStartNewHarness(binding.harnessId, distributionId)) throw new Error("This provider is unavailable in the active distribution.")
      const ticket = signTerminalTicket({
        laneId,
        paneId,
        harnessId: binding.harnessId,
        generation: binding.generation,
        mode: "attach",
        runtimeIdentity: runtimeIdentityValue,
      })
      return NextResponse.json({
        ticket,
        binding,
        mode: "attach",
        guidanceIncluded: false,
        guidanceSource: "none",
      }, { headers: { "cache-control": "no-store" } })
    }

    if (!Number.isSafeInteger(body.expectedGeneration) || Number(body.expectedGeneration) < 1) throw new Error("Invalid terminal binding generation.")
    const expectedGeneration = Number(body.expectedGeneration)
    if (binding.generation !== expectedGeneration) {
      if (body.action === "resume-bound"
        && binding.generation === expectedGeneration + 1
        && binding.harnessId === "omp"
        && binding.resumeSessionId) {
        if (!canStartNewHarness("omp", distributionId)) throw new Error("This provider is unavailable in the active distribution.")
        return exactResumeResponse(laneId, paneId, binding, runtimeIdentityValue)
      }
      return bindingChanged(binding)
    }

    let harnessId: HarnessId = binding.harnessId
    let resumeSessionId: string | null = null
    let mode: "start" | "resume-exact" | "choose-omp-session" = "start"
    let systemPrompt: string | undefined
    let guidanceIncluded = false
    let guidanceSource: string | null = "none"

    if (body.action === "start" || body.action === "new-session") {
      if (body.harnessId !== "omp" && body.harnessId !== "codex" && body.harnessId !== "shell") throw new Error("Choose a valid harness.")
      if (!canStartNewHarness(body.harnessId, distributionId)) throw new Error("This provider is unavailable in the active distribution.")
      if (body.action === "start" && binding.resumeSessionId) throw new Error("This terminal is already bound. Start a new session to replace it.")
      harnessId = body.harnessId
      if (body.action === "start") {
        const role = terminalPaneConfig(pane)?.role ?? "additional"
        const guidance = await terminalGuidance({
          recipeId: lane.recipeId,
          role,
          harnessId,
          requested: Boolean(body.useGuidance && harnessId !== "shell" && !binding.kickoffSent),
        })
        systemPrompt = agentSystemPrompt(harnessId, guidance.prompt, runtimeIdentityValue)
        guidanceIncluded = Boolean(guidance.prompt)
        guidanceSource = guidance.source
      }
    } else if (body.action === "resume-bound") {
      if (binding.harnessId !== "omp" || !binding.resumeSessionId) {
        return NextResponse.json({
          code: "TERMINAL_UNBOUND",
          error: "No exact terminal session is bound to this pane.",
          binding,
        }, { status: 409, headers: { "cache-control": "no-store" } })
      }
      if (!canStartNewHarness("omp", distributionId)) throw new Error("This provider is unavailable in the active distribution.")
      harnessId = "omp"
      resumeSessionId = binding.resumeSessionId
      mode = "resume-exact"
    } else {
      if (binding.resumeSessionId) throw new Error("This terminal is already bound. Start a new session to replace it.")
      if (!canStartNewHarness("omp", distributionId)) throw new Error("This provider is unavailable in the active distribution.")
      harnessId = "omp"
      mode = "choose-omp-session"
    }

    const proposedGeneration = binding.generation + 1
    const proposedTicket = signTerminalTicket({
      laneId,
      paneId,
      harnessId,
      generation: proposedGeneration,
      mode,
      runtimeIdentity: runtimeIdentityValue,
      systemPrompt,
      resumeSessionId: resumeSessionId ?? undefined,
      guidanceIncluded,
    })

    const advanced = advanceTerminalBinding(database(), {
      laneId,
      paneId,
      expected: {
        generation: binding.generation,
        harnessId: binding.harnessId,
        resumeSessionId: binding.resumeSessionId,
        kickoffSent: binding.kickoffSent,
      },
      harnessId,
      resume: resumeSessionId,
    })
    if (!advanced) {
      const current = getLane(laneId)?.terminalBindings[paneId]
      if (current && body.action === "resume-bound"
        && current.generation === binding.generation + 1
        && current.harnessId === "omp"
        && current.resumeSessionId === binding.resumeSessionId) {
        return exactResumeResponse(laneId, paneId, current, runtimeIdentityValue)
      }
      return current ? bindingChanged(current) : NextResponse.json({
        code: "TERMINAL_BINDING_INVARIANT",
        error: "Terminal pane has no binding.",
      }, { status: 500, headers: { "cache-control": "no-store" } })
    }
    const { laneId: _laneId, ...advancedBinding } = advanced
    return NextResponse.json({
      ticket: proposedTicket,
      binding: advancedBinding,
      mode,
      guidanceIncluded,
      guidanceSource,
    }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to create terminal ticket.",
    }, { status: 400, headers: { "cache-control": "no-store" } })
  }
}
