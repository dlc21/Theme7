import { randomUUID } from "node:crypto"

export type ClientControlIntent =
  | {
      id: string
      kind: "open_web_preview"
      laneId: string
      sourcePaneId: string
      location: string
      createdAt: number
      expiresAt: number
    }
  | {
      id: string
      kind: "close_terminal"
      laneId: string
      sourcePaneId: string
      expectedGeneration: number
      createdAt: number
      expiresAt: number
    }

type ClientControlIntentInput =
  | { kind: "open_web_preview"; laneId: string; sourcePaneId: string; location: string; ttlMs?: number }
  | { kind: "close_terminal"; laneId: string; sourcePaneId: string; expectedGeneration: number; ttlMs?: number }
type OpenWebPreviewIntent = Extract<ClientControlIntent, { kind: "open_web_preview" }>
type CloseTerminalIntent = Extract<ClientControlIntent, { kind: "close_terminal" }>
type OpenWebPreviewIntentInput = Extract<ClientControlIntentInput, { kind: "open_web_preview" }>
type CloseTerminalIntentInput = Extract<ClientControlIntentInput, { kind: "close_terminal" }>

declare global {
  // eslint-disable-next-line no-var
  var operatorEngineClientControlIntents: Map<string, ClientControlIntent> | undefined
}

function intents(): Map<string, ClientControlIntent> {
  globalThis.operatorEngineClientControlIntents ??= new Map()
  return globalThis.operatorEngineClientControlIntents
}

function prune(now = Date.now()): void {
  for (const [id, intent] of intents()) if (intent.expiresAt <= now) intents().delete(id)
}

export function queueClientControlIntent(input: OpenWebPreviewIntentInput): OpenWebPreviewIntent
export function queueClientControlIntent(input: CloseTerminalIntentInput): CloseTerminalIntent
export function queueClientControlIntent(input: ClientControlIntentInput): ClientControlIntent {
  prune()
  if (input.kind === "close_terminal") {
    for (const intent of intents().values()) {
      if (intent.kind === "close_terminal" && intent.laneId === input.laneId && intent.sourcePaneId === input.sourcePaneId && intent.expectedGeneration === input.expectedGeneration) {
        return intent
      }
    }
  }
  const createdAt = Date.now()
  const common = {
    id: randomUUID(),
    laneId: input.laneId,
    sourcePaneId: input.sourcePaneId,
    createdAt,
    expiresAt: createdAt + Math.min(60_000, Math.max(5_000, input.ttlMs ?? 60_000)),
  }
  const intent: ClientControlIntent = input.kind === "open_web_preview"
    ? { ...common, kind: input.kind, location: input.location }
    : { ...common, kind: input.kind, expectedGeneration: input.expectedGeneration }
  intents().set(intent.id, intent)
  return intent
}

export function listClientControlIntents(laneId: string): ClientControlIntent[] {
  prune()
  return [...intents().values()].filter((intent) => intent.laneId === laneId).sort((a, b) => a.createdAt - b.createdAt)
}

export function acknowledgeClientControlIntent(laneId: string, intentId: string): boolean {
  prune()
  const intent = intents().get(intentId)
  if (!intent || intent.laneId !== laneId) return false
  intents().delete(intentId)
  return true
}

export function clearClientControlIntentsForTests(): void {
  intents().clear()
}
