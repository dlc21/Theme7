import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  LANE_NOTE_FILENAME,
  parseLaneSettingsInput,
  readLaneNote,
  saveLaneNote,
} from "@/lib/lane-info"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("lane settings", () => {
  it("validates and normalizes the editable settings", () => {
    expect(parseLaneSettingsInput({ name: "  Client launch  ", defaultHarness: "omp", note: "  Resume from Activity.  " }, "theme-7")).toEqual({
      name: "Client launch",
      defaultHarness: "omp",
      note: "Resume from Activity.",
    })
    expect(() => parseLaneSettingsInput({ name: " ", defaultHarness: "shell", note: "" }, "stock")).toThrow("Name is required")
    expect(() => parseLaneSettingsInput({ name: "Lane", defaultHarness: "omp", note: "" }, "stock")).toThrow("unavailable")
    expect(parseLaneSettingsInput({ name: "Lane", defaultHarness: "codex", note: "" }, "stock").defaultHarness).toBe("codex")
    expect(() => parseLaneSettingsInput({ name: "Lane", defaultHarness: "shell", note: "x".repeat(4_001) }, "stock")).toThrow("Lane note must be")
  })

  it("keeps the lane note in the folder and removes only the note when cleared", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-lane-settings-"))
    temporaryDirectories.push(directory)

    expect(await readLaneNote(directory)).toBe("")
    await saveLaneNote(directory, "Resume from the browser preview.")
    expect(await readLaneNote(directory)).toBe("Resume from the browser preview.")
    expect(await fs.readFile(path.join(directory, LANE_NOTE_FILENAME), "utf8")).toBe("Resume from the browser preview.\n")

    await saveLaneNote(directory, "")
    await expect(fs.stat(path.join(directory, LANE_NOTE_FILENAME))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await fs.stat(directory)).isDirectory()).toBe(true)
  })
})
