import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  checkReleaseSurface,
  collectReleaseSurfaceFindings,
  inspectTgz,
  inspectTrackedFile,
  scanReleaseText,
  trackedRegularFiles,
} from "./check-release-surface.mjs"

const temporary = []
const join = (...parts) => parts.join("")
const decoded = (value) => Buffer.from(value, "base64").toString("utf8")
const keyHeaderPrefix = "-----BEGIN OPENSSH "
const keyHeaderKind = join("PRIVATE ", "KEY-----")
const hidden = Object.freeze({
  ownerLogin: decoded("ZGF2aWRsaW5jMQ=="),
  oldRepository: join("operator", "-studio", "-client"),
  sourceCommit: join("dadbe4f8d27084136a74", "33523f3368d2c0e165a4"),
  privateHost: join("operator", "-studio.", "rare", "signal", ".ai"),
  tailnetHost: join("node.example.", "ts.net"),
  windowsHome: join("C:/", "Users/", "reviewer/project"),
  macHome: join("/", "Users/", "reviewer/project"),
  linuxHome: join("/", "home/", "reviewer/project"),
  privateAddress: join("192.168.", "40.12"),
  keyHeader: join(keyHeaderPrefix, keyHeaderKind),
  credentialKey: join("API", "_TOKEN"),
  credentialValue: join("live", "-credential-value"),
  credentialUrl: join("https://account:", "credential-value@example.test/path"),
})

function writeTarString(header, offset, length, value) {
  Buffer.from(value).copy(header, offset, 0, Math.min(Buffer.byteLength(value), length))
}

function writeTarOctal(header, offset, length, value) {
  writeTarString(header, offset, length, value.toString(8).padStart(length - 1, "0"))
}

function tarMember(name, source = "", type = "0") {
  const content = Buffer.isBuffer(source) ? source : Buffer.from(source)
  const header = Buffer.alloc(512)
  writeTarString(header, 0, 100, name)
  writeTarOctal(header, 100, 8, 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, content.length)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  writeTarString(header, 156, 1, type)
  writeTarString(header, 257, 6, "ustar")
  writeTarString(header, 263, 2, "00")
  writeTarOctal(header, 148, 8, [...header].reduce((sum, value) => sum + value, 0))
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([header, content, padding])
}

function tgz(...members) {
  return gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]), { mtime: 0 })
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporary.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })))
})

describe("release surface privacy and security policy", () => {
  it.each([
    ["personal-identifier", hidden.ownerLogin],
    ["old-repository", hidden.oldRepository],
    ["private-source-commit", hidden.sourceCommit],
    ["private-hostname", hidden.privateHost],
    ["private-hostname", hidden.tailnetHost],
    ["user-home-path", hidden.windowsHome],
    ["user-home-path", hidden.macHome],
    ["user-home-path", hidden.linuxHome],
    ["private-lan-address", hidden.privateAddress],
    ["private-key", hidden.keyHeader],
    ["credential", `${hidden.credentialKey} = ${hidden.credentialValue}`],
    ["credentialed-url", hidden.credentialUrl],
  ])("detects %s without disclosing sensitive values", (category, source) => {
    const findings = scanReleaseText("notes/review.txt", source)
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ category, path: "notes/review.txt" })]))
    if (["credential", "credentialed-url", "private-key"].includes(category)) {
      expect(findings.find((finding) => finding.category === category)?.source).toBe("[redacted]")
    }
  })

  it("allows exact loopback only in reviewed runtime, network-test, and safety contexts", () => {
    const loopbacks = join("http://127.0.0.1:4400 http://localhost:4400 http://[", "::1]:4400")
    expect(scanReleaseText("lib/config.ts", loopbacks)).toEqual([])
    expect(scanReleaseText("scripts/network-probe.test.mjs", loopbacks)).toEqual([])
    expect(scanReleaseText("SECURITY.md", loopbacks)).toEqual([])
    expect(scanReleaseText("notes/review.txt", loopbacks).filter(({ category }) => category === "unreviewed-loopback")).toHaveLength(3)
    expect(scanReleaseText("lib/config.ts", join("127.0.", "0.2"))).toEqual([expect.objectContaining({ category: "unreviewed-loopback" })])
  })

  it("permits documentation addresses and rejects LAN addresses", () => {
    expect(scanReleaseText("tests/network.spec.ts", "https://192.0.2.20:8443")).toEqual([])
    expect(scanReleaseText("tests/network.spec.ts", hidden.privateAddress)).toEqual([expect.objectContaining({ category: "private-lan-address" })])
  })

  it("exempts only the exact Theme7 license notices", () => {
    const notice = decoded("Q29weXJpZ2h0IChjKSAyMDI2IERhdmlkIExpbi1DbGFyaw==")
    expect(scanReleaseText("LICENSE", notice)).toEqual([])
    expect(scanReleaseText("theme-7-edition/LICENSE", notice)).toEqual([])
    expect(scanReleaseText("vendor/theme-7-0.1.0.tgz!package/LICENSE", notice)).toEqual([])
  })

  it("inspects printable metadata in committed binary images", () => {
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from(`profile=${hidden.windowsHome}`), Buffer.from([0, 1, 2])])
    expect(inspectTrackedFile("public/mark.png", bytes)).toEqual([expect.objectContaining({ category: "user-home-path", path: "public/mark.png" })])
  })

  it("unpacks tgz members and rejects links and traversal", () => {
    const assignment = `${hidden.credentialKey}=${hidden.credentialValue}`
    const archive = tgz(
      tarMember("package/package.json", JSON.stringify({ name: "fixture" })),
      tarMember("package/config.env", assignment),
      tarMember("package/link", "target", "2"),
      tarMember("../outside.txt", "safe"),
    )
    const findings = inspectTgz("vendor/package.tgz", archive)
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "credential", path: "vendor/package.tgz!package/config.env" }),
      expect.objectContaining({ category: "archive-link", path: "vendor/package.tgz!package/link" }),
      expect.objectContaining({ category: "archive-path", path: "vendor/package.tgz" }),
    ]))
  })

  it("enumerates only Git-tracked files and follows no ignored material", async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "operator-engine-release-surface-"))
    temporary.push(directory)
    await fsp.writeFile(path.join(directory, ".gitignore"), "ignored.txt\n")
    await fsp.writeFile(path.join(directory, "README.md"), "Operator Engine\n")
    await fsp.writeFile(path.join(directory, "private.txt"), hidden.ownerLogin)
    await fsp.writeFile(path.join(directory, "ignored.txt"), hidden.keyHeader)
    runGit(directory, ["init", "--initial-branch=main"])
    runGit(directory, ["add", ".gitignore", "README.md", "private.txt"])

    expect(trackedRegularFiles(directory)).toEqual([".gitignore", "README.md", "private.txt"])
    const result = collectReleaseSurfaceFindings(directory)
    expect(result.findings).toEqual([expect.objectContaining({ category: "personal-identifier", path: "private.txt" })])
    expect(() => checkReleaseSurface(directory)).toThrow("Release surface contains restricted material")
  })

  it("does not contain its assembled private sentinels", () => {
    const scanner = fs.readFileSync(new URL("./check-release-surface.mjs", import.meta.url), "utf8")
    const tests = fs.readFileSync(new URL("./check-release-surface.test.mjs", import.meta.url), "utf8")
    for (const sentinel of [hidden.ownerLogin, hidden.oldRepository, hidden.sourceCommit, hidden.privateHost, hidden.keyHeader]) {
      expect(scanner).not.toContain(sentinel)
      expect(tests).not.toContain(sentinel)
    }
  })

  it("does not execute the CLI when imported", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.resetModules()
    await expect(import("./check-release-surface.mjs")).resolves.toBeDefined()
    expect(stdout).not.toHaveBeenCalled()
  })
})
