export type TerminalControlAction = "open_web_preview" | "close_terminal"

export type TerminalControlCapability = {
  laneId: string
  paneId: string
  generation: number
  actions: TerminalControlAction[]
  expiresAt: number
}

export function validateTerminalIdentity(laneId: string, paneId: string): void
export function signTerminalControlCapability(
  input: { laneId: string; paneId: string; generation: number; ttlMs?: number },
  env?: NodeJS.ProcessEnv,
): string
export function verifyTerminalControlCapability(
  token: string,
  requiredAction: TerminalControlAction,
  env?: NodeJS.ProcessEnv,
): TerminalControlCapability | null
