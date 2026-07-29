import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parseEnvFile, readJson, writeJson } from "./state-io.mjs"

describe("state IO", () => {
  it("parses environment text", () => expect(parseEnvFile("A=one\nB='two'\ninvalid")).toEqual({ A: "one", B: "two" }))
  it("returns the configured missing value only for absent files", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "state-io-"))
    expect(await readJson(path.join(root, "missing.json"), { missing: "absent" })).toBe("absent")
    await fsp.writeFile(path.join(root, "bad.json"), "{")
    await expect(readJson(path.join(root, "bad.json"))).rejects.toThrow()
    await fsp.rm(root, { recursive: true, force: true })
  })
  it("writes formatted JSON atomically", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "state-io-")); const file = path.join(root, "nested", "state.json")
    await writeJson(file, { ok: true }, { privateFile: true })
    expect(await fsp.readFile(file, "utf8")).toBe('{\n  "ok": true\n}\n')
    await fsp.rm(root, { recursive: true, force: true })
  })
})
