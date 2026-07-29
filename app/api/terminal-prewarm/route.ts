import { NextResponse } from "next/server"

import { agentSystemPrompt } from "@/lib/agent-guidance"
import { findPane } from "@/lib/bento-layout"
import { ompPrewarmEnabled, ompPrewarmTtlMs } from "@/lib/config"
import { database, getLane } from "@/lib/db"
import { activeReviewedDistribution, runtimeIdentity } from "@/lib/distributions"
import {
  cancelPrewarmedOmpTerminal,
  prewarmOmpTerminal,
  TerminalPrewarmRelayError,
} from "@/lib/terminal-relay-control"
import { signTerminalTicket, validateTerminalIdentity } from "@/lib/terminal-ticket"
import { terminalGuidance } from "@/lib/terminal-guidance"
import type { TerminalBinding } from "@/lib/types"
import {
  createTerminalBinding,
  getTerminalBinding,
  planTerminalBindingCreation,
  settleTerminalReservation,
} from "../../../scripts/terminal-binding-store.mjs"
import type { StoredTerminalBinding } from "../../../scripts/terminal-binding-store.mjs"

export const runtime = "nodejs"

function browserBinding(binding: StoredTerminalBinding): TerminalBinding {
  const { laneId: _laneId, ...publicBinding } = binding
  return publicBinding
}

function bindingConflict(binding: StoredTerminalBinding | null) {
  return NextResponse.json({
    code: "TERMINAL_BINDING_CHANGED",
    error: "This terminal changed in another window.",
    binding: binding ? browserBinding(binding) : null,
  }, { status: 409, headers: { "cache-control": "no-store" } })
}

async function settleFailedPrewarm(
  db: ReturnType<typeof database>,
  identity: { laneId: string; paneId: string; generation: number },
  error: unknown,
) {
  if (error instanceof TerminalPrewarmRelayError && error.spawned === false) {
    settleTerminalReservation(db, identity)
    return
  }
  try {
    await cancelPrewarmedOmpTerminal(identity.laneId, identity.paneId, identity.generation)
  } catch {
    // Unknown relay settlement keeps the durable provisional row for later TTL cleanup.
  }
}

export async function POST(request: Request) {
  let provisional: { laneId: string; paneId: string; generation: number } | null = null
  try {
    if (!ompPrewarmEnabled()) return NextResponse.json({ enabled: false }, { status: 404 })
    const reviewed = await activeReviewedDistribution()
    if (!reviewed) return NextResponse.json({ enabled: false }, { status: 404 })
    const runtimeIdentityValue = runtimeIdentity(reviewed.distribution.id)
    const body = await request.json() as { laneId?: string; paneId?: string; expectedGeneration?: unknown }
    const laneId = body.laneId?.trim() ?? ""
    const paneId = body.paneId?.trim() ?? ""
    validateTerminalIdentity(laneId, paneId)
    const lane = getLane(laneId)
    if (!lane?.layout) return NextResponse.json({ error: "Lane not found." }, { status: 404 })
    if (lane.defaultHarness !== "omp") throw new Error("OMP prewarm requires an OMP-default lane.")
    if (findPane(lane.layout.tree, paneId)) throw new Error("Terminal pane identity is already in use.")

    const db = database()
    const ttlMs = ompPrewarmTtlMs()
    if (body.expectedGeneration !== undefined) {
      if (!Number.isSafeInteger(body.expectedGeneration) || Number(body.expectedGeneration) < 1) {
        throw new Error("Invalid terminal binding generation.")
      }
      const binding = getTerminalBinding(db, laneId, paneId)
      if (!binding || binding.generation !== Number(body.expectedGeneration)) return bindingConflict(binding)
      if (binding.harnessId !== "omp") throw new Error("OMP prewarm reservation changed providers.")
      const ticket = signTerminalTicket({
        laneId,
        paneId,
        harnessId: "omp",
        generation: binding.generation,
        mode: "attach",
        runtimeIdentity: runtimeIdentityValue,
      })
      const expiresAt = await prewarmOmpTerminal(ticket, ttlMs)
      return NextResponse.json({
        enabled: true,
        expiresAt,
        binding: browserBinding(getTerminalBinding(db, laneId, paneId) ?? binding),
      }, { headers: { "cache-control": "no-store" } })
    }

    const guidance = await terminalGuidance({
      recipeId: lane.recipeId,
      role: "additional",
      harnessId: "omp",
      requested: Boolean(lane.recipeId),
    })
    const planned = planTerminalBindingCreation(db, laneId, paneId)
    if ("generation" in planned) return bindingConflict(planned)
    const generation = planned.nextGeneration
    const ticket = signTerminalTicket({
      laneId,
      paneId,
      harnessId: "omp",
      generation,
      mode: "start",
      runtimeIdentity: runtimeIdentityValue,
      systemPrompt: agentSystemPrompt("omp", guidance.prompt, runtimeIdentityValue),
      guidanceIncluded: Boolean(guidance.prompt),
    })
    const created = createTerminalBinding(db, {
      laneId,
      paneId,
      harnessId: "omp",
      kickoffSent: false,
      expectedLastGeneration: planned.expectedLastGeneration,
    })
    if (created === "epoch-conflict" || created.generation !== generation) {
      return bindingConflict(getTerminalBinding(db, laneId, paneId))
    }
    provisional = { laneId, paneId, generation }
    try {
      const expiresAt = await prewarmOmpTerminal(ticket, ttlMs)
      const current = getTerminalBinding(db, laneId, paneId) ?? created
      provisional = null
      return NextResponse.json({
        enabled: true,
        expiresAt,
        binding: browserBinding(current),
      }, { headers: { "cache-control": "no-store" } })
    } catch (error) {
      await settleFailedPrewarm(db, { laneId, paneId, generation }, error)
      provisional = null
      throw error
    }
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to prewarm OMP.",
      ...(provisional ? { provisional } : {}),
    }, { status: 400, headers: { "cache-control": "no-store" } })
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { laneId?: string; paneId?: string; expectedGeneration?: unknown }
    const laneId = body.laneId?.trim() ?? ""
    const paneId = body.paneId?.trim() ?? ""
    validateTerminalIdentity(laneId, paneId)
    if (!Number.isSafeInteger(body.expectedGeneration) || Number(body.expectedGeneration) < 1) {
      throw new Error("Invalid terminal binding generation.")
    }
    const cancelled = await cancelPrewarmedOmpTerminal(laneId, paneId, Number(body.expectedGeneration))
    return NextResponse.json({ cancelled }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to cancel OMP prewarm.",
    }, { status: 400, headers: { "cache-control": "no-store" } })
  }
}
