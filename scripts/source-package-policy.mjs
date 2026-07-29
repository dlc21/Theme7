#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const automaticPackageFiles = ["LICENSE", "README.md", "package.json"]
const forbiddenPackagePaths = [
  ".git/",
  ".github/",
  ".operator-engine/",
  "client-workspace/",
  "scripts/update-t4-integration.mjs",
  "vendor/archive/",
]

function normalize(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "")
}

function assertDeclaredEntry(entry) {
  if (typeof entry !== "string" || !entry.trim()) throw new Error("package.json files entries must be non-empty strings.")
  const normalized = normalize(entry)
  if (normalized !== entry || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe package files entry: ${entry}`)
  }
  if (/[*?\[\]{}]/.test(normalized)) throw new Error(`Package files entry must not use a glob: ${entry}`)
  return normalized
}

function walkFiles(directory, relative = "") {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = normalize(path.posix.join(relative, entry.name))
    const child = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Source package input is a symlink: ${childRelative}`)
    if (entry.isDirectory()) files.push(...walkFiles(child, childRelative))
    else if (entry.isFile()) files.push(childRelative)
    else throw new Error(`Source package input is not a regular file: ${childRelative}`)
  }
  return files
}

export function expandDeclaredPackageFiles(repositoryRoot, entries) {
  if (!Array.isArray(entries)) throw new Error("package.json must declare a files array.")
  const normalizedEntries = entries.map(assertDeclaredEntry)
  if (new Set(normalizedEntries).size !== normalizedEntries.length) throw new Error("package.json files entries must be unique.")
  const files = new Set(automaticPackageFiles)
  for (const entry of normalizedEntries) {
    const absolute = path.join(repositoryRoot, entry)
    if (!fs.existsSync(absolute)) throw new Error(`Declared package input does not exist: ${entry}`)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error(`Declared package input is a symlink: ${entry}`)
    if (stat.isFile()) files.add(entry)
    else if (stat.isDirectory()) for (const file of walkFiles(absolute, entry)) files.add(file)
    else throw new Error(`Declared package input is not a regular file or directory: ${entry}`)
  }
  return [...files].sort()
}

function npmCliPath() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) return process.env.npm_execpath
  const candidates = process.platform === "win32"
    ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    : [path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error("Unable to locate npm CLI. Run this check through npm.")
  return found
}

export function npmPackDryRun(repositoryRoot) {
  const result = spawnSync(process.execPath, [npmCliPath(), "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `npm pack exited ${result.status}`)
  const records = JSON.parse(result.stdout)
  if (!Array.isArray(records) || records.length !== 1 || !Array.isArray(records[0]?.files)) throw new Error("npm pack returned an unexpected manifest.")
  return records[0]
}

export function validateSourcePackageSurface(repositoryRoot, packageRecord) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
  const expected = expandDeclaredPackageFiles(repositoryRoot, packageJson.files)
  const actual = packageRecord.files.map(({ path: file }) => normalize(file)).sort()
  const missing = expected.filter((file) => !actual.includes(file))
  const unexpected = actual.filter((file) => !expected.includes(file))
  const unsafe = actual.filter((file) => {
    const lower = file.toLowerCase()
    return forbiddenPackagePaths.some((candidate) => file === candidate || file.startsWith(candidate))
      || (path.posix.basename(lower).startsWith(".env") && path.posix.basename(lower) !== ".env.example")
      || /(?:\.sqlite3?|\.db)(?:-(?:wal|shm))?$/.test(lower)
      || /(?:^|\/)scripts\/launcher\/(?:bin|obj|out)(?:\/|$)/i.test(file)
      || /\.(?:dll|exe|pdb)$/i.test(file)
  })
  if (missing.length || unexpected.length || unsafe.length) {
    throw new Error([
      "Source package surface differs from package.json files policy.",
      missing.length ? `Missing: ${missing.join(", ")}` : "",
      unexpected.length ? `Unexpected: ${unexpected.join(", ")}` : "",
      unsafe.length ? `Unsafe: ${unsafe.join(", ")}` : "",
    ].filter(Boolean).join("\n"))
  }
  return { name: packageRecord.name, version: packageRecord.version, files: actual }
}

export function checkSourcePackageSurface(repositoryRoot = root) {
  return validateSourcePackageSurface(repositoryRoot, npmPackDryRun(repositoryRoot))
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = checkSourcePackageSurface()
  process.stdout.write(`Source package surface OK: ${result.files.length} files.\n`)
}
