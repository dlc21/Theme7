import type { HarnessAvailability, HarnessId } from "../lib/types"

export type ResolvedExecutable = { executable: string; prefixArgs: string[]; versionArgs?: string[] }
export const harnessAdapters: Record<HarnessId, { id: HarnessId; label: string; supportsGuidance: boolean; resolve(env?: NodeJS.ProcessEnv): ResolvedExecutable | null; help: string; command(options: Record<string, unknown>): { executable: string; args: string[] } }>
export function harnessInstallHelp(id: HarnessId, platform?: NodeJS.Platform): { command: string; docs: string; note: string }
export function detectHarnesses(): Promise<HarnessAvailability[]>
export function resolveCodex(env?: NodeJS.ProcessEnv): ResolvedExecutable | null
export function resolveShell(env?: NodeJS.ProcessEnv): ResolvedExecutable | null
export function probeResolved(resolved: ResolvedExecutable | null, timeoutMs?: number): Promise<{ ok: boolean; missing: boolean; version?: string }>
