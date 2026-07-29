import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { gunzipSync } from "node:zlib"

const root = process.cwd()
const assembled = (...parts) => parts.join("")
const decoded = (value) => Buffer.from(value, "base64").toString("utf8")
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const privateLiterals = Object.freeze([
  ["personal-identifier", decoded("ZGF2aWRsaW5jMQ==")],
  ["personal-identifier", decoded("TmF0ZQ==")],
  ["company-identifier", assembled("Hyper", "giant")],
  ["company-identifier", assembled("Way", "points", "ginc")],
  ["company-identifier", assembled("Rare ", "Signal")],
  ["company-identifier", assembled("rare", "signal")],
  ["workstation-identifier", assembled("Mega", "lith")],
  ["workstation-identifier", assembled("Super", "void")],
  ["workstation-identifier", assembled("Operator Studio", " Remote")],
  ["old-repository", assembled("operator", "-studio")],
  ["old-repository", assembled("os", "-client")],
  ["old-repository", assembled("omp", "-theme", "-7")],
  ["old-repository", assembled("operator-engine", "-review")],
  ["private-planning", assembled("operator-engine", "-private", "-planning")],
  ["private-hostname", assembled("os.", "waypoints", "ginc.com")],
  ["private-hostname", assembled("operator", "-studio.", "rare", "signal", ".ai")],
  ["private-namespace", assembled("operator", "-studio", "-prod")],
])

const knownSourceCommits = Object.freeze([
  assembled("dadbe4f8d27084136a74", "33523f3368d2c0e165a4"),
  assembled("f7ec2fdc95954bd45f0b", "6d865e112f74f5c23ce0"),
  assembled("7aed7dc62055a3c02084", "4e7d1e7956b289eb3dcee"),
  assembled("069d6529dae98987a4e6", "ae7d9f414867e9f6f4e8"),
])

const wordBoundedPersonalIdentifier = assembled("Na", "te")
const literalPatterns = privateLiterals.map(([category, value]) => ({ category, label: category, pattern: new RegExp(value === wordBoundedPersonalIdentifier ? `\\b${escaped(value)}\\b` : escaped(value), "i") }))
const commitPatterns = knownSourceCommits.map((value) => ({ category: "private-source-commit", label: "known private source commit", pattern: new RegExp(escaped(value), "i") }))
const tailnetHostname = /\b[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net\b/i
const privateKeyHeader = new RegExp(assembled("-----BEGIN ", "[^-]*PRIVATE ", "KEY(?: BLOCK)?-----"))
const credentialAssignment = /(?:^|[\s{,])['"]?([A-Za-z][A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|token))['"]?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s,;#}]+))/i
const safeCredentialValue = /^(?:\$\{[^}]+\}|<[^>]+>|(?:replace-with|example|placeholder|change-?me|fixture|synthetic|test)(?:-.+)?|(?:.+-)?not-a-secret(?:-.+)?)$/i
const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi
const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const canonicalIpv4Loopback = assembled("127.0.", "0.1")
const bracketedIpv6Loopback = assembled("[::", "1]")
const loopbackHostname = assembled("local", "host")
const localhostPattern = new RegExp(`\\b${loopbackHostname}\\b`, "gi")
const userHomePatterns = [
  /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'<>]+/g,
  /\/(?:Users|home)\/[^/\s"'<>]+/g,
]

const textExtensions = new Set([
  ".cjs", ".cmd", ".conf", ".cs", ".csproj", ".css", ".cts", ".csv", ".d.ts", ".env", ".example", ".gitignore", ".html", ".ini", ".js", ".json", ".json5", ".jsx", ".lock", ".md", ".mdx", ".mjs", ".mts", ".npmrc", ".ps1", ".scss", ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
])

const loopbackFiles = new Set([
  ".env.example",
  "BUILDING.md",
  "Dockerfile",
  "README.md",
  "SECURITY.md",
  "compose.yaml",
  "components/web-preview-pane.tsx",
  "lib/browser-location.ts",
  "lib/config.ts",
  "lib/terminal-control-request.ts",
  "playwright.config.ts",
  "scripts/adapter-smoke.mjs",
  "scripts/doctor.mjs",
  "scripts/distribution-adapters.mjs",
  "scripts/local-train-core.mjs",
  "scripts/local-train.mjs",
  "scripts/network-probe.mjs",
  "scripts/operator-engine.mjs",
  "scripts/run.mjs",
  "scripts/runtime-config-core.mjs",
  "scripts/setup.mjs",
  "scripts/shell-pty-smoke.mjs",
  "scripts/terminal-lifecycle-smoke.mjs",
  "scripts/start-operator-engine.cmd",
  "scripts/terminal-relay.mjs",
  "scripts/validate-container.mjs",
  "scripts/prove-recovery.mjs",
])

function normalizedRelative(relative) {
  return relative.replaceAll("\\", "/")
}

function isLoopbackContext(relative) {
  const outer = normalizedRelative(relative.split("!")[0])
  return loopbackFiles.has(outer)
    || outer.startsWith("tests/browser/")
    || /(?:^|\/)network[^/]*\.test\.[cm]?[jt]s$/.test(outer)
    || /\.test\.[cm]?[jt]sx?$/.test(outer)
    || /\.spec\.[cm]?[jt]sx?$/.test(outer)
}

function expectedLicenseNotice(relative, line) {
  const normalized = normalizedRelative(relative)
  const allowed = new Set(["LICENSE", "theme-7-edition/LICENSE", "vendor/theme-7-0.1.0.tgz!package/LICENSE"])
  if (!allowed.has(normalized)) return false
  return line.trim() === decoded("Q29weXJpZ2h0IChjKSAyMDI2IERhdmlkIExpbi1DbGFyaw==")
}


function sourcePreview(category, line) {
  if (["credential", "credentialed-url", "private-key"].includes(category)) return "[redacted]"
  return line.trim().slice(0, 240)
}

function finding(category, relative, lineNumber, pattern, line) {
  return {
    category,
    path: normalizedRelative(relative),
    line: lineNumber,
    pattern,
    source: sourcePreview(category, line),
  }
}

function credentialFinding(relative, line, index) {
  const codeFile = /\.[cm]?[jt]sx?$/.test(relative.split("!").at(-1) ?? relative)
  if (privateKeyHeader.test(line)) return finding("private-key", relative, index + 1, "private key header", line)
  const match = line.match(credentialAssignment)
  if (!match) return null
  const key = match[1]
  const value = match[2] ?? match[3] ?? match[4] ?? match[5] ?? ""
  const normalizedValue = value.trim()
  const quoted = match[2] !== undefined || match[3] !== undefined || match[4] !== undefined
  if (!normalizedValue || safeCredentialValue.test(normalizedValue)) return null
  if (!quoted) {
    const codeAssignment = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(line)
    if (codeFile || codeAssignment || key !== key.toUpperCase() || !/^[A-Za-z0-9_./+=:@-]{8,}$/.test(normalizedValue)) return null
  }
  return finding("credential", relative, index + 1, "credential assignment", line)
}

function credentialedUrlFinding(relative, line, index) {
  for (const match of line.matchAll(urlPattern)) {
    const raw = match[0].replace(/[),.;]+$/, "")
    try {
      const parsed = new URL(raw)
      if (parsed.username || parsed.password) return finding("credentialed-url", relative, index + 1, "URL user information", line)
      for (const [key, value] of parsed.searchParams) {
        if (/(?:api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)/i.test(key) && value && !safeCredentialValue.test(value)) {
          return finding("credentialed-url", relative, index + 1, "URL credential query", line)
        }
      }
    } catch {
      continue
    }
  }
  return null
}

function ipv4Kind(value) {
  const octets = value.split(".").map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  if (value === canonicalIpv4Loopback) return "loopback"
  if (octets[0] === 127) return "noncanonical-loopback"
  if (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)) return "private-lan"
  return null
}

function pathFindings(relative, line, index) {
  const findings = []
  for (const pattern of userHomePatterns) {
    pattern.lastIndex = 0
    if (pattern.test(line)) findings.push(finding("user-home-path", relative, index + 1, "user home path", line))
  }
  return findings
}

function networkFindings(relative, line, index) {
  const findings = []
  const reviewedLoopback = isLoopbackContext(relative)
  for (const match of line.matchAll(ipv4Pattern)) {
    const kind = ipv4Kind(match[0])
    if (kind === "private-lan") findings.push(finding("private-lan-address", relative, index + 1, "RFC 1918 address", line))
    if ((kind === "loopback" && !reviewedLoopback) || kind === "noncanonical-loopback") findings.push(finding("unreviewed-loopback", relative, index + 1, "loopback literal outside reviewed context", line))
  }
  localhostPattern.lastIndex = 0
  if (localhostPattern.test(line) && !reviewedLoopback) findings.push(finding("unreviewed-loopback", relative, index + 1, `${loopbackHostname} outside reviewed context`, line))
  if ((line.includes(bracketedIpv6Loopback) || /(^|[^:]):{2}1(?:[^:0-9a-f]|$)/i.test(line)) && !reviewedLoopback) findings.push(finding("unreviewed-loopback", relative, index + 1, "IPv6 loopback outside reviewed context", line))
  if (tailnetHostname.test(line)) findings.push(finding("private-hostname", relative, index + 1, "tailnet hostname", line))
  return findings
}

function isAllowedThreadIngestReference(line) {
  return line.includes("@operator-studio/thread-ingest") || line.includes("operator-studio-thread-ingest")
}

export function scanReleaseText(relative, source) {
  const findings = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    for (const { category, label, pattern } of [...literalPatterns, ...commitPatterns]) {
      if (pattern.test(line) && !expectedLicenseNotice(relative, line) && !isAllowedThreadIngestReference(line)) findings.push(finding(category, relative, index + 1, label, line))
    }
    findings.push(...pathFindings(relative, line, index))
    findings.push(...networkFindings(relative, line, index))
    const credential = credentialFinding(relative, line, index)
    if (credential) findings.push(credential)
    const credentialedUrl = credentialedUrlFinding(relative, line, index)
    if (credentialedUrl) findings.push(credentialedUrl)
  }
  return findings
}

function extensionOf(relative) {
  const lower = relative.toLowerCase()
  if (lower.endsWith(".d.ts")) return ".d.ts"
  return path.posix.extname(lower)
}

function printableMetadata(bytes) {
  const ascii = bytes.toString("latin1").replace(/[^\t\n\r\x20-\x7e]+/g, "\n")
  const utf16le = bytes.toString("utf16le").replace(/[^\t\n\r\x20-\x7e]+/g, "\n")
  return [...new Set([...ascii.split(/\r?\n/), ...utf16le.split(/\r?\n/)].map((value) => value.trim()).filter((value) => value.length >= 4))].join("\n")
}

function scanBytes(relative, bytes) {
  const source = textExtensions.has(extensionOf(relative)) || !bytes.includes(0)
    ? bytes.toString("utf8")
    : printableMetadata(bytes)
  return scanReleaseText(relative, source)
}

function tarString(header, start, length) {
  return header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "").trim()
}

function tarNumber(header, start, length) {
  const raw = tarString(header, start, length).replace(/^0+/, "")
  if (!raw) return 0
  if (!/^[0-7]+$/.test(raw)) throw new Error("invalid tar number")
  return Number.parseInt(raw, 8)
}

function safeArchivePath(name) {
  const normalized = name.replaceAll("\\", "/")
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null
  const parts = normalized.split("/")
  if (parts.some((part) => part === ".." || part === "")) return null
  return parts.filter((part) => part !== ".").join("/")
}

function paxPath(bytes) {
  const source = bytes.toString("utf8")
  for (const record of source.split("\n")) {
    const separator = record.indexOf(" ")
    if (separator < 0) continue
    const field = record.slice(separator + 1)
    if (field.startsWith("path=")) return field.slice(5)
  }
  return null
}

export function inspectTgz(relative, bytes) {
  const findings = []
  let archive
  try {
    archive = gunzipSync(bytes)
  } catch {
    return [finding("invalid-archive", relative, 1, "gzip", "Archive could not be decompressed")]
  }

  let offset = 0
  let pendingPath = null
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) break
    let size
    try {
      size = tarNumber(header, 124, 12)
    } catch {
      findings.push(finding("invalid-archive", relative, 1, "tar size", "Archive member has an invalid size"))
      break
    }
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (!Number.isSafeInteger(size) || contentEnd > archive.length) {
      findings.push(finding("invalid-archive", relative, 1, "tar bounds", "Archive member exceeds archive bounds"))
      break
    }
    const type = String.fromCharCode(header[156] || 48)
    const prefix = tarString(header, 345, 155)
    const headerName = [prefix, tarString(header, 0, 100)].filter(Boolean).join("/")
    const content = archive.subarray(contentStart, contentEnd)

    if (type === "x") {
      pendingPath = paxPath(content)
    } else if (type === "L") {
      pendingPath = content.toString("utf8").replace(/\0.*$/s, "").trim()
    } else {
      const memberName = pendingPath ?? headerName
      pendingPath = null
      const safeName = safeArchivePath(memberName)
      if (!safeName) {
        findings.push(finding("archive-path", relative, 1, "unsafe archive path", memberName))
      } else {
        const member = `${normalizedRelative(relative)}!${safeName}`
        findings.push(...scanReleaseText(`${member}!name`, memberName))
        if (type === "0" || type === "\0") findings.push(...scanBytes(member, content))
        else if (type !== "5" && type !== "g") findings.push(finding("archive-link", member, 1, `tar member type ${JSON.stringify(type)}`, memberName))
      }
    }
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  return findings
}

function deduplicate(findings) {
  const seen = new Set()
  return findings.filter((item) => {
    const key = `${item.category}\0${item.path}\0${item.line}\0${item.pattern}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function inspectTrackedFile(relative, bytes) {
  return deduplicate(relative.toLowerCase().endsWith(".tgz") ? inspectTgz(relative, bytes) : scanBytes(relative, bytes))
}

export function trackedRegularFiles(rootDirectory) {
  const result = spawnSync("git", ["ls-files", "-z", "--cached"], { cwd: rootDirectory, encoding: "buffer", windowsHide: true })
  if (result.status !== 0) throw new Error(`Could not enumerate Git-tracked files: ${result.stderr?.toString("utf8").trim() || "git ls-files failed"}`)
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort()
}

export function collectReleaseSurfaceFindings(rootDirectory = root) {
  const findings = []
  const files = trackedRegularFiles(rootDirectory)
  for (const relative of files) {
    const absolute = path.join(rootDirectory, relative)
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile()) {
      findings.push(finding(stat.isSymbolicLink() ? "tracked-symlink" : "tracked-nonregular", relative, 1, "tracked path must be a regular file", relative))
      continue
    }
    findings.push(...inspectTrackedFile(relative, fs.readFileSync(absolute)))
  }
  return { files, findings: deduplicate(findings) }
}

function formatFinding(item) {
  return `${item.path}:${item.line}: [${item.category}] ${item.pattern}${item.source ? ` (${item.source})` : ""}`
}

export function checkReleaseSurface(rootDirectory = root) {
  const result = collectReleaseSurfaceFindings(rootDirectory)
  if (result.findings.length) throw new Error(`Release surface contains restricted material:\n${result.findings.map(formatFinding).join("\n")}`)
  return { fileCount: result.files.length, archiveCount: result.files.filter((relative) => relative.toLowerCase().endsWith(".tgz")).length }
}

function isDirectCli() {
  return path.basename(process.argv[1] ?? "") === "check-release-surface.mjs"
}

if (isDirectCli()) {
  const result = checkReleaseSurface(root)
  process.stdout.write(`Release surface clean (${result.fileCount} tracked files; ${result.archiveCount} archives).\n`)
}
