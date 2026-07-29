import type Database from "better-sqlite3"

export type StoredTerminalBinding = {
  laneId: string
  paneId: string
  harnessId: "omp" | "codex" | "shell"
  resumeSessionId: string | null
  kickoffSent: boolean
  generation: number
  updatedAt: string
}

export type TerminalBindingSnapshot = Pick<
  StoredTerminalBinding,
  "generation" | "harnessId" | "resumeSessionId" | "kickoffSent"
>

export type TerminalBindingCreationPlan = {
  expectedLastGeneration: number | null
  nextGeneration: number
}

export type TerminalReservationSettlement = {
  status: "consumed" | "superseded" | "deleted" | "missing" | "binding-conflict"
  binding: StoredTerminalBinding | null
}

export function ensureTerminalContinuitySchema(db: Database.Database): boolean
export function getTerminalBinding(db: Database.Database, laneId: string, paneId: string): StoredTerminalBinding | null
export function listTerminalBindings(db: Database.Database, laneId?: string): StoredTerminalBinding[]
export function planTerminalBindingCreation(
  db: Database.Database,
  laneId: string,
  paneId: string,
): StoredTerminalBinding | TerminalBindingCreationPlan
export function createTerminalBinding(
  db: Database.Database,
  input: {
    laneId: string
    paneId: string
    harnessId: StoredTerminalBinding["harnessId"]
    kickoffSent?: boolean
    expectedLastGeneration?: number | null
  },
): StoredTerminalBinding | "epoch-conflict"
export function advanceTerminalBinding(
  db: Database.Database,
  input: {
    laneId: string
    paneId: string
    expected: TerminalBindingSnapshot
    harnessId: StoredTerminalBinding["harnessId"]
    resume: string | null
  },
): StoredTerminalBinding | null
export function setTerminalBindingIdentity(
  db: Database.Database,
  input: { laneId: string; paneId: string; generation: number; resumeSessionId: string },
): StoredTerminalBinding | null
export function markTerminalGuidanceStarted(
  db: Database.Database,
  input: { laneId: string; paneId: string; generation: number },
): StoredTerminalBinding | null
export function deleteTerminalBinding(
  db: Database.Database,
  input: { laneId: string; paneId: string; expectedGeneration: number },
): StoredTerminalBinding | null
export function settleTerminalReservation(
  db: Database.Database,
  input: { laneId: string; paneId: string; generation: number },
): TerminalReservationSettlement
export function deleteAbandonedTerminalBindings(
  db: Database.Database,
  relayStartedAt: string,
): StoredTerminalBinding[]
