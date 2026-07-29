import fs from "node:fs/promises"
import path from "node:path"

import type { DistributionId } from "@/lib/distributions"
import { canStartNewHarness } from "@/lib/harness-policy"
import type { HarnessId } from "@/lib/types"

export const LANE_NOTE_FILENAME = "LANE.md"
export const MAX_LANE_NAME_LENGTH = 120
export const MAX_LANE_NOTE_LENGTH = 4_000

export type LaneSettingsInput = {
  name: string
  defaultHarness: HarnessId
  note: string
}

export function parseLaneSettingsInput(value: unknown, distributionId: DistributionId): LaneSettingsInput {
  if (!value || typeof value !== "object") throw new Error("Lane settings are required.")
  const candidate = value as Record<string, unknown>
  const name = typeof candidate.name === "string" ? candidate.name.trim() : ""
  const note = typeof candidate.note === "string" ? candidate.note.trim() : ""
  const defaultHarness = candidate.defaultHarness

  if (!name) throw new Error("Name is required.")
  if (name.length > MAX_LANE_NAME_LENGTH) throw new Error(`Name must be ${MAX_LANE_NAME_LENGTH} characters or fewer.`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("Name cannot contain control characters.")
  if (note.length > MAX_LANE_NOTE_LENGTH) throw new Error(`Lane note must be ${MAX_LANE_NOTE_LENGTH.toLocaleString()} characters or fewer.`)
  if ((defaultHarness !== "omp" && defaultHarness !== "codex" && defaultHarness !== "shell") || !canStartNewHarness(defaultHarness, distributionId)) throw new Error("Default terminal is unavailable in the active distribution.")

  return { name, defaultHarness, note }
}

async function laneNotePath(laneRoot: string): Promise<{ root: string; file: string }> {
  const root = await fs.realpath(laneRoot)
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error("Lane folder is unavailable.")
  return { root, file: path.join(root, LANE_NOTE_FILENAME) }
}

async function existingNoteFile(laneRoot: string): Promise<string | null> {
  const { file } = await laneNotePath(laneRoot)
  try {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) throw new Error(`${LANE_NOTE_FILENAME} cannot be a symbolic link.`)
    if (!stat.isFile()) throw new Error(`${LANE_NOTE_FILENAME} is not a file.`)
    return file
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export async function readLaneNote(laneRoot: string): Promise<string> {
  const file = await existingNoteFile(laneRoot)
  if (!file) return ""
  const stat = await fs.stat(file)
  if (stat.size > MAX_LANE_NOTE_LENGTH * 4) throw new Error(`${LANE_NOTE_FILENAME} is too large to edit here.`)
  return (await fs.readFile(file, "utf8")).trim()
}

export async function saveLaneNote(laneRoot: string, note: string): Promise<void> {
  const existing = await existingNoteFile(laneRoot)
  if (!note) {
    if (existing) await fs.unlink(existing)
    return
  }
  const { file } = await laneNotePath(laneRoot)
  await fs.writeFile(file, `${note}\n`, { encoding: "utf8", mode: 0o600 })
}
