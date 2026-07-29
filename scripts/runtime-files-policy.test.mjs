import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { CONTAINER_RUNTIME_FILES, materializeRuntimeFiles, RUNTIME_FILES, validateRuntimeFilePolicy } from "./runtime-files-policy.mjs"

const temporary = []

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "operator-engine-runtime-files-"))
  temporary.push(root)
  for (const relative of RUNTIME_FILES) {
    const target = path.join(root, relative)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, relative)
  }
  return root
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })))
})

describe("runtime file policy", () => {
  it("declares one exact portable runtime surface", async () => {
    const root = await fixture()
    expect(validateRuntimeFilePolicy(root)).toEqual([...RUNTIME_FILES])
    expect(RUNTIME_FILES).toContain("scripts/run.mjs")
    expect(RUNTIME_FILES).toContain("scripts/bin/operator-engine.cmd")
    expect(RUNTIME_FILES.some((relative) => relative.includes("test"))).toBe(false)
    expect(RUNTIME_FILES.some((relative) => relative.includes("local-train"))).toBe(false)
  })

  it("declares a smaller Linux container surface without setup or review files", async () => {
    const root = await fixture()
    expect(validateRuntimeFilePolicy(root, CONTAINER_RUNTIME_FILES)).toEqual([...CONTAINER_RUNTIME_FILES])
    expect(CONTAINER_RUNTIME_FILES).toContain("LICENSE")
    expect(CONTAINER_RUNTIME_FILES).toContain("scripts/bin/operator-engine")
    expect(CONTAINER_RUNTIME_FILES).toContain("scripts/run.mjs")
    expect(CONTAINER_RUNTIME_FILES).toContain("scripts/terminal-spectator-policy.mjs")
    expect(CONTAINER_RUNTIME_FILES).not.toContain(".env.example")
    expect(CONTAINER_RUNTIME_FILES).not.toContain("README.md")
    expect(CONTAINER_RUNTIME_FILES).not.toContain("SECURITY.md")
    expect(CONTAINER_RUNTIME_FILES).not.toContain("scripts/bin/operator-engine.cmd")
    expect(CONTAINER_RUNTIME_FILES).not.toContain("scripts/doctor.mjs")
    expect(CONTAINER_RUNTIME_FILES).not.toContain("scripts/setup.mjs")
    expect(CONTAINER_RUNTIME_FILES.every((relative) => RUNTIME_FILES.includes(relative))).toBe(true)
  })

  it("materializes only declared files and removes stale output", async () => {
    const root = await fixture()
    const destination = path.join(root, "output")
    await fsp.mkdir(destination)
    await fsp.writeFile(path.join(destination, "stale.txt"), "stale")
    await expect(materializeRuntimeFiles(root, destination)).resolves.toEqual([...RUNTIME_FILES])
    await expect(fsp.access(path.join(destination, "stale.txt"))).rejects.toThrow()
    for (const relative of RUNTIME_FILES) await expect(fsp.readFile(path.join(destination, relative), "utf8")).resolves.toBe(relative)
  })

  it("materializes only the declared container runtime surface", async () => {
    const root = await fixture()
    const destination = path.join(root, "container-output")
    await expect(materializeRuntimeFiles(root, destination, { files: CONTAINER_RUNTIME_FILES })).resolves.toEqual([...CONTAINER_RUNTIME_FILES])
    for (const relative of CONTAINER_RUNTIME_FILES) {
      await expect(fsp.readFile(path.join(destination, relative), "utf8")).resolves.toBe(relative)
    }
    await expect(fsp.access(path.join(destination, "README.md"))).rejects.toThrow()
    await expect(fsp.access(path.join(destination, "scripts", "setup.mjs"))).rejects.toThrow()
  })

  it("rejects missing and non-regular inputs", async () => {
    const root = await fixture()
    await fsp.rm(path.join(root, RUNTIME_FILES[0]))
    expect(() => validateRuntimeFilePolicy(root)).toThrow(`Runtime file is missing: ${RUNTIME_FILES[0]}`)
    await fsp.mkdir(path.join(root, RUNTIME_FILES[0]))
    expect(() => validateRuntimeFilePolicy(root)).toThrow(`Runtime file must be a regular file: ${RUNTIME_FILES[0]}`)
  })
})
