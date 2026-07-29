import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runRuntimeTargetCli } from "./runtime-target.mjs"

const HEAD = "a".repeat(40)
const OTHER = "b".repeat(40)
let directory, statePath, output, errors

beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "runtime-target-")); statePath = path.join(directory, ".operator-engine", "runtime-target.json"); output = []; errors = [] })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function run(args, fetchImpl, repositoryCommit = async () => HEAD) {
  return runRuntimeTargetCli({ args, statePath, fetchImpl, repositoryCommit, stdout: (message) => output.push(message), stderr: (message) => errors.push(message) })
}
async function state() { return JSON.parse(await readFile(statePath, "utf8")) }
const identity = (port, sourceCommit = HEAD) => ({ sourceCommit, distribution: "stock", role: "development", mode: "hmr", webPort: port, terminalPort: 4701, dataClass: "isolated", releaseId: null, contentSha256: null })
const capabilities = (port, sourceCommit = HEAD) => async () => new Response(JSON.stringify({ runtimeIdentity: identity(port, sourceCommit) }), { status: 200, headers: { "content-type": "application/json" } })

describe("runtime target CLI", () => {
  it("binds once and refuses target substitution", async () => {
    expect(await run(["bind", "http://127.0.0.1:4700/"])).toBe(0)
    expect(await state()).toEqual({ schemaVersion: 1, reportedTarget: "http://127.0.0.1:4700", status: "bound", verifiedTarget: null })
    expect(await run(["bind", "http://127.0.0.1:4450/"])).toBe(1)
  })
  it("rejects deploy and verify origin mismatches without changing state", async () => {
    await run(["bind", "http://127.0.0.1:4700"])
    expect(await run(["assert", "deploy", "http://127.0.0.1:4450"])).toBe(1)
    expect(await run(["verify", "http://127.0.0.1:4450"], capabilities(4450))).toBe(1)
    expect((await state()).status).toBe("bound")
  })
  it("verifies a complete identity matching the repository commit", async () => {
    await run(["bind", "http://127.0.0.1:4700"])
    expect(await run(["verify", "http://127.0.0.1:4700"], capabilities(4700))).toBe(0)
    expect((await state()).status).toBe("verified")
  })
  it("rejects a stale commit on the correct port", async () => {
    await run(["bind", "http://127.0.0.1:4700"])
    expect(await run(["verify", "http://127.0.0.1:4700"], capabilities(4700, OTHER))).toBe(1)
    expect(errors.at(-1)).toBe(`Runtime build mismatch: repository ${HEAD}, target reports ${OTHER}.`)
    expect((await state()).status).toBe("bound")
  })
  it("rejects missing provenance and a wrong port without state mutation", async () => {
    await run(["bind", "http://127.0.0.1:4700"])
    expect(await run(["verify", "http://127.0.0.1:4700"], capabilities(4700, null))).toBe(1)
    expect(errors.at(-1)).toBe("Runtime build identity is unavailable at http://127.0.0.1:4700.")
    expect(await run(["verify", "http://127.0.0.1:4700"], capabilities(4702))).toBe(1)
    expect(errors.at(-1)).toContain("runtimeIdentity.webPort 4702 does not match target port 4700")
    expect((await state()).status).toBe("bound")
  })
  it("fails before fetching when repository commit lookup fails", async () => {
    await run(["bind", "http://127.0.0.1:4700"])
    let fetched = false
    expect(await run(["verify", "http://127.0.0.1:4700"], async () => { fetched = true }, async () => { throw new Error("git") })).toBe(1)
    expect(fetched).toBe(false)
    expect(errors.at(-1)).toBe("Unable to determine the repository commit for runtime verification.")
    expect((await state()).status).toBe("bound")
  })
  it("keeps pending state and only clears verified state", async () => {
    await run(["bind", "http://127.0.0.1:4700"])
    expect(await run(["check"])).toBe(1)
    expect(await run(["clear"])).toBe(1)
    expect((await state()).status).toBe("bound")
    await run(["verify", "http://127.0.0.1:4700"], capabilities(4700))
    expect(await run(["check"])).toBe(0)
    expect(await run(["clear"])).toBe(0)
  })
})
