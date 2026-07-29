import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { ompTheme7 } from "../dist/index.js"
import { ompAdapter, resolveOmp } from "../dist/server-adapter.js"
import { readOmpSessionMetadata } from "../dist/session-records.js"
import ompTheme7Identity from "../dist/identity-extension.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const expectedTrackedFiles = [
  ".gitattributes",
  ".gitignore",
  "LICENSE",
  "README.md",
  "dist/identity-extension.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/server-adapter.js",
  "dist/session-records.d.ts",
  "dist/session-records.js",
  "edition/assets/claude-ruin.svg",
  "edition/assets/geocities-fire-b.gif",
  "edition/assets/geocities-fire-c.gif",
  "edition/assets/geocities-fire-slow-a.gif",
  "edition/assets/geocities-fire-slow-b.gif",
  "edition/assets/geocities-fire-slow-c.gif",
  "edition/assets/geocities-fire.gif",
  "edition/assets/theme-seven-mark.svg",
  "edition/assets/onboarding.svg",
  "edition/edition.json",
  "edition/theme.css",
  "package.json",
  "starter/browser-showpiece/index.html",
  "test/package.test.mjs",
]
const expectedPackageFiles = expectedTrackedFiles.filter((file) =>
  file === "LICENSE"
  || file === "README.md"
  || file === "package.json"
  || file.startsWith("dist/")
  || file.startsWith("edition/")
  || file.startsWith("starter/"),
)
const forbiddenSentinels = [
  ["operator", "studio", "client"].join("-"),
  ["OS", "CLIENT"].join("_"),
  ["omp", "theme", "7"].join("-"),
  ["operator", "engine", "review"].join("-"),
  Buffer.from("ZGF2aWRsaW5jMQ==", "base64").toString("utf8"),
  ["rare", "signal"].join(""),
  ["waypoints", "ginc"].join(""),
  ["mega", "lith"].join(""),
  ["super", "void"].join(""),
  ["wooly", "mango"].join(""),
  ["hyper", "giant"].join(""),
]
const allowedUrls = new Set([
  "http://www.w3.org/2000/svg",
  "https://github.com/can1357/oh-my-pi",
  "https://omp.sh/",
  "https://omp.sh/install.ps1",
  "https://omp.sh/install",
])
const textExtensions = new Set([".css", ".d.ts", ".html", ".js", ".json", ".md", ".mjs", ".svg"])

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`)
  return result.stdout
}

function trackedFiles() {
  return run("git", ["ls-files", "-z"]).split("\0").filter(Boolean).sort()
}

function assertSafePath(file) {
  const normalized = file.replaceAll("\\", "/")
  const parts = normalized.split("/")
  assert.equal(path.posix.isAbsolute(normalized), false, `absolute path: ${file}`)
  assert.equal(parts.includes(".."), false, `path traversal: ${file}`)
  assert.equal(parts.includes("archive"), false, `retained archive path: ${file}`)
  assert.equal(parts.includes(".git"), false, `Git payload path: ${file}`)
  assert.notEqual(normalized, ".gitmodules", `Git payload path: ${file}`)
}

function printableText(buffer) {
  return [...buffer.toString("latin1").matchAll(/[\x20-\x7e]{4,}/g)].map((match) => match[0]).join("\n")
}

function assertSafeContent(label, buffer) {
  const extension = label.endsWith(".d.ts") ? ".d.ts" : path.extname(label).toLowerCase()
  const text = textExtensions.has(extension) || [".gitignore", "LICENSE"].includes(path.basename(label))
    ? buffer.toString("utf8")
    : printableText(buffer)
  const lower = text.toLowerCase()
  for (const sentinel of forbiddenSentinels) {
    assert.equal(lower.includes(sentinel.toLowerCase()), false, `${label}: forbidden identifier`)
  }
  assert.doesNotMatch(text, /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP|PRIVATE) [A-Z ]*KEY-----/)
  assert.doesNotMatch(text, /https?:\/\/[^/\s:@]+:[^@\s/]+@/i)
  assert.doesNotMatch(text, /(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i)
  assert.doesNotMatch(text, /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s]+/i)
  assert.doesNotMatch(text, /\/(?:Users|home)\/[^/\s]+(?:\/|$)/)
  assert.doesNotMatch(text, /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/)
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`)\]}]+/g)) {
    const url = match[0].replace(/[,.!?;]+$/, "")
    assert.equal(allowedUrls.has(url), true, `${label}: unexpected URL ${url}`)
  }
}

function tarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset)
  return buffer.subarray(offset, end >= offset && end < offset + length ? end : offset + length).toString("utf8")
}

function tarOctal(buffer, offset, length) {
  const value = tarString(buffer, offset, length).trim()
  return value ? Number.parseInt(value, 8) : 0
}

function parseTarball(file) {
  const archive = gunzipSync(fs.readFileSync(file))
  const entries = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = [tarString(header, 345, 155), tarString(header, 0, 100)].filter(Boolean).join("/")
    const size = tarOctal(header, 124, 12)
    const type = header[156]
    const mode = tarOctal(header, 100, 8)
    const contentOffset = offset + 512
    entries.push({ name, size, type, mode, content: archive.subarray(contentOffset, contentOffset + size) })
    offset = contentOffset + Math.ceil(size / 512) * 512
  }
  return entries
}
test("exports the reviewed distribution payload", () => {
  assert.equal(ompTheme7.distribution.id, "theme-7")
  assert.equal(ompTheme7.distribution.edition.id, "theme-7")
  assert.equal(ompTheme7.distribution.edition.brand.productName, "Theme7")
  assert.equal(ompTheme7.distribution.edition.name, "Theme7")
  assert.equal(ompTheme7.distribution.edition.brand.subtitle, "Job Harness")
  assert.equal(ompTheme7.distribution.edition.brand.icon, "assets/theme-seven-mark.svg")
  assert.ok(fs.existsSync(path.join(root, "edition/assets/theme-seven-mark.svg")))
  assert.match(fs.readFileSync(path.join(root, "edition/theme.css"), "utf8"), /data-distribution="theme-7"/)
  assert.deepEqual(ompTheme7.distribution.onboarding.intro, { title: "welcome to Theme7", lines: ["Theme7 keeps real folders, terminals, and AI-assisted work together in one workspace.", "Let's create a job and get started."], actionLabel: "start tour" })
  assert.equal(ompTheme7.distribution.onboarding.steps.length, 5)
  assert.equal(ompTheme7.distribution.starter.entry, "index.html")
  assert.equal(ompTheme7.distribution.edition.terminalShowpiece.version, 1)
  assert.equal(ompTheme7.distribution.edition.terminalShowpiece.mode, "replace")
  assert.equal(ompTheme7.distribution.edition.terminalShowpiece.experiences.length, 10)
  assert.deepEqual(ompTheme7.distribution.edition.terminalShowpiece.experiences.map(({ id }) => id), ["chromatic-aperture", "particle-magnetism", "pixel-bloom", "signal-decode", "type-assembly", "prism-strike", "orbital-slingshot", "liquid-merge", "glyph-rain", "mosaic-flip"])
  for (const experience of ompTheme7.distribution.edition.terminalShowpiece.experiences) {
    assert.ok(experience.primitives.some((primitive) => primitive.kind === "text" && primitive.variant === "loader" && primitive.value === "OMP // SPAWNING AGENT_"))
  }
})
test("keeps the packaged Edition manifest aligned with the distribution identity", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "edition/edition.json"), "utf8"))
  const edition = ompTheme7.distribution.edition
  assert.equal(manifest.id, ompTheme7.distribution.id)
  assert.equal(manifest.id, edition.id)
  assert.equal(manifest.name, edition.name)
  assert.equal(manifest.description, edition.description)
  assert.deepEqual(manifest.brand, edition.brand)
  assert.deepEqual(manifest.terms, edition.terms)
  assert.equal(manifest.surfaces["agent-card:omp"].label, edition.surfaces["agent-card:omp"].label)
  assert.deepEqual(ompTheme7.distribution.providerIds, ["omp", "shell"])
  assert.equal(ompTheme7.distribution.panes["t4-code"].label, "T4 Code")
})
test("uses only the canonical configured OMP path", () => {
  assert.deepEqual(resolveOmp({ OPERATOR_ENGINE_OMP_BIN: "/fixture/omp", PATH: "" }, "linux"), { executable: "/fixture/omp", prefixArgs: [] })
  assert.equal(resolveOmp({ PATH: "" }, "linux"), null)
})
test("uses OMP's canonical installer endpoints", () => {
  assert.deepEqual(ompAdapter.installHelp("win32"), {
    command: "irm https://omp.sh/install.ps1 | iex",
    docs: "https://github.com/can1357/oh-my-pi",
    note: "Review and run the official installer yourself; it does not edit Theme7 credentials.",
  })
  assert.deepEqual(ompAdapter.installHelp("linux"), {
    command: "curl -fsSL https://omp.sh/install | sh",
    docs: "https://github.com/can1357/oh-my-pi",
    note: "Review and run the official installer yourself; it does not edit Theme7 credentials.",
  })
})
test("reports exact OMP session identity through the canonical handshake", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "theme-7-identity-"))
  const identityFile = path.join(directory, "identity.jsonl")
  const previousFile = process.env.OPERATOR_ENGINE_OMP_IDENTITY_FILE
  const previousNonce = process.env.OPERATOR_ENGINE_OMP_IDENTITY_NONCE
  let sessionId = "session-one"
  const sessionFile = path.join(directory, "session.jsonl")
  const handlers = new Map()
  try {
    process.env.OPERATOR_ENGINE_OMP_IDENTITY_FILE = identityFile
    process.env.OPERATOR_ENGINE_OMP_IDENTITY_NONCE = "nonce-one"
    ompTheme7Identity({ on: (event, handler) => handlers.set(event, handler) })
    const context = {
      cwd: directory,
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
      },
    }
    handlers.get("session_start")({ type: "session_start" }, context)
    handlers.get("session_switch")({ type: "session_switch" }, context)
    sessionId = "session-two"
    handlers.get("session_branch")({ type: "session_branch" }, context)
    const records = fs.readFileSync(identityFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line))
    assert.deepEqual(records, [
      { version: 1, nonce: "nonce-one", sessionId: "session-one", cwd: directory, sessionFile },
      { version: 1, nonce: "nonce-one", sessionId: "session-two", cwd: directory, sessionFile },
    ])
  } finally {
    if (previousFile === undefined) delete process.env.OPERATOR_ENGINE_OMP_IDENTITY_FILE
    else process.env.OPERATOR_ENGINE_OMP_IDENTITY_FILE = previousFile
    if (previousNonce === undefined) delete process.env.OPERATOR_ENGINE_OMP_IDENTITY_NONCE
    else process.env.OPERATOR_ENGINE_OMP_IDENTITY_NONCE = previousNonce
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
test("builds fresh and resume launches", () => {
  const executable = { executable: "/fixture/omp", prefixArgs: [] }
  assert.deepEqual(ompAdapter.buildLaunch({ executable, trustedIdentityExtension: "/trusted/identity.js" }), { executable: "/fixture/omp", args: ["--extension=/trusted/identity.js"] })
  assert.deepEqual(ompAdapter.buildLaunch({ executable, resumeSessionId: "abc", systemPrompt: "guide" }), { executable: "/fixture/omp", args: ["--resume", "abc", "--append-system-prompt", "guide"] })
})
test("starter is self contained and package metadata is anonymous", () => {
  const html = fs.readFileSync(path.join(root, "starter/browser-showpiece/index.html"), "utf8")
  assert.match(html, /your job can make interfaces now/)
  assert.match(html, /ask for html then open it here/)
  assert.doesNotMatch(html, /https?:|<script|src=/i)
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  for (const key of ["author", "contributors", "homepage", "repository", "funding", "private"]) assert.equal(key in metadata, false)
})
test("documents the assets as one built-in Theme7 application surface", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8")
  assert.match(readme, /part of the Theme7 application/)
  assert.match(readme, /not a selectable theme or a separate distribution/)
  assert.match(readme, /official Theme7 container pins and includes OMP/)
  assert.doesNotMatch(readme, /OPERATOR_ENGINE_DISTRIBUTION/)
})
test("parses bounded OMP session headers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "theme-7-"))
  const file = path.join(directory, "session.jsonl")
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "session-one", cwd: directory, timestamp: new Date().toISOString(), title: "first job" })}\n`)
  await assert.doesNotReject(async () => assert.equal((await readOmpSessionMetadata(file))?.id, "session-one"))
  fs.rmSync(directory, { recursive: true, force: true })
})

test("reviews the exact tracked repository surface", () => {
  const files = trackedFiles()
  assert.deepEqual(files, [...expectedTrackedFiles].sort())
  for (const file of files) {
    assertSafePath(file)
    const absolute = path.join(root, file)
    const stat = fs.lstatSync(absolute)
    assert.equal(stat.isSymbolicLink(), false, `${file}: symlink`)
    assert.equal(stat.isFile(), true, `${file}: not a regular file`)
    assertSafeContent(file, fs.readFileSync(absolute))
  }
})

test("pins package text to reproducible LF checkouts", () => {
  const attributes = fs.readFileSync(path.join(root, ".gitattributes"), "utf8")
  assert.match(attributes, /^\* text=auto eol=lf$/m)
  for (const file of expectedPackageFiles) {
    const extension = file.endsWith(".d.ts") ? ".d.ts" : path.extname(file).toLowerCase()
    if (!textExtensions.has(extension) && path.basename(file) !== "LICENSE") continue
    assert.equal(fs.readFileSync(path.join(root, file)).includes(Buffer.from("\r\n")), false, `${file}: CRLF`)
  }
})

test("packs only the declared reviewed package surface", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "theme-7-pack-"))
  try {
    assert.ok(process.env.npm_execpath, "npm did not expose its CLI path")
    const packed = JSON.parse(run(process.execPath, [process.env.npm_execpath, "pack", "--json", "--pack-destination", temporary]))
    assert.equal(packed.length, 1)
    assert.equal(packed[0].name, "theme-7")
    assert.equal(packed[0].version, "0.1.0")
    assert.deepEqual(packed[0].files.map(({ path: file }) => file).sort(), [...expectedPackageFiles].sort())

    const archive = path.join(temporary, packed[0].filename)
    const entries = parseTarball(archive)
    const files = []
    for (const entry of entries) {
      assert.match(entry.name, /^package\//)
      const relative = entry.name.slice("package/".length)
      assertSafePath(relative)
      if (entry.type === 53) continue
      assert.ok(entry.type === 0 || entry.type === 48, `${relative}: unsupported tar type ${entry.type}`)
      assert.equal(entry.mode & 0o777, 0o644, `${relative}: unexpected mode`)
      files.push(relative)
      assertSafeContent(relative, entry.content)
    }
    assert.deepEqual(files.sort(), [...expectedPackageFiles].sort())
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test("privacy checks reject constructed unsafe fixtures", () => {
  const credential = [["TOKEN", "="].join(""), "\"", ["not", "a", "real", "credential"].join("-"), "\""].join("")
  const userInfoUrl = ["https", "://", "user", ":", "pass", "@", "example.invalid"].join("")
  const retired = ["operator", "studio", "client"].join("-")
  assert.throws(() => assertSafeContent("fixture.txt", Buffer.from(credential)), /TOKEN/i)
  assert.throws(() => assertSafeContent("fixture.txt", Buffer.from(userInfoUrl)), /match|expected/i)
  assert.throws(() => assertSafeContent("fixture.txt", Buffer.from(retired)), /forbidden identifier/)
  assert.throws(() => assertSafePath(["archive", "lost.js"].join("/")), /archive/)
  assert.throws(() => assertSafePath(["..", "escape.js"].join("/")), /traversal/)
})
