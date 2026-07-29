import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveOmp } from "theme-7/server-adapter"

import { firstAvailableNewHarness } from "../lib/harness-policy"
import { detectHarnesses, harnessAdapters, probeResolved, resolveCodex } from "./harness-adapters.mjs"

const original = { ...process.env }
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
})

describe("harness adapters", () => {
  it("prefers canonical OMP and Codex overrides", () => {
    expect(resolveOmp({ OPERATOR_ENGINE_OMP_BIN: "/opt/omp", OMP_BIN: "/old/omp", PATH: "" })?.executable).toBe("/opt/omp")
    expect(resolveCodex({ OPERATOR_ENGINE_CODEX_BIN: "/opt/codex", CODEX_BIN: "/old/codex", PATH: "" })?.executable).toBe("/opt/codex")
  })

  it("reports a missing version probe without exposing environment", async () => {
    expect(await probeResolved({ executable: path.join(os.tmpdir(), "definitely-missing-client-harness"), prefixArgs: [] }, 100)).toMatchObject({ ok: false, missing: true })
  })

  it("injects guidance through each agent harness instruction channel", () => {
    process.env.OPERATOR_ENGINE_OMP_BIN = process.execPath
    process.env.OPERATOR_ENGINE_CODEX_BIN = process.execPath
    expect(harnessAdapters.omp.command({ cwd: process.cwd(), systemPrompt: "hello" }).args).toEqual(["--append-system-prompt", "hello"])
    expect(harnessAdapters.codex.command({ cwd: process.cwd(), systemPrompt: "hello\nworld" }).args).toEqual(["--no-alt-screen", "-c", "developer_instructions=\"hello\\nworld\""])
    expect(harnessAdapters.codex.command({ cwd: process.cwd(), resumeSessionId: "session-123" }).args).toEqual(["--no-alt-screen", "resume", "session-123"])
    expect(harnessAdapters.shell.supportsGuidance).toBe(false)
    expect(harnessAdapters.shell.command({ cwd: process.cwd(), systemPrompt: "never send this" }).args).not.toContain("never send this")
  })

  it("loads the reviewed OMP identity extension explicitly", () => {
    process.env.OPERATOR_ENGINE_OMP_BIN = process.execPath
    expect(harnessAdapters.omp.command({ identityExtension: "C:/operator-engine/identity-extension.js" }).args)
      .toEqual(["--extension=C:/operator-engine/identity-extension.js"])
  })

  it("uses an exact OMP session resume id with the server system prompt", () => {
    process.env.OPERATOR_ENGINE_OMP_BIN = process.execPath
    expect(harnessAdapters.omp.command({ cwd: process.cwd(), systemPrompt: "hello", resumeSessionId: "session-123" }).args).toEqual(["--resume", "session-123", "--append-system-prompt", "hello"])
  })

  it("opens the OMP resume picker when no exact id is known", () => {
    process.env.OPERATOR_ENGINE_OMP_BIN = process.execPath
    expect(harnessAdapters.omp.command({ cwd: process.cwd(), resumePicker: true }).args).toEqual(["--resume"])
  })

  it("selects and starts fresh Codex in stock with the fixture adapter", async () => {
    process.env.OPERATOR_ENGINE_CODEX_BIN = path.resolve(import.meta.dirname, "../tests/fixtures/fake-codex.mjs")
    const availability = await detectHarnesses()
    expect(firstAvailableNewHarness(availability, "stock")).toBe("codex")
    const launch = harnessAdapters.codex.command({})
    const result = spawnSync(launch.executable, launch.args, { encoding: "utf8", windowsHide: true })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(["--no-alt-screen"])
  })

  it("redacts resolved executable paths from availability", async () => {
    process.env.OPERATOR_ENGINE_OMP_BIN = process.execPath
    const availability = await detectHarnesses()
    expect(JSON.stringify(availability)).not.toContain(process.execPath)
  })
})
