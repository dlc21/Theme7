import fs from "node:fs"
import path from "node:path"

const root = process.cwd()

export const stockSurfaceFiles = Object.freeze([
  "app/layout.tsx",
  "components/app-sidebar.tsx",
  "components/directory-picker.tsx",
  "components/lane-settings.tsx",
  "components/pane-registry.tsx",
  "components/workbench.tsx",
])

const phrase = (...parts) => parts.join("")
export const STOCK_FORBIDDEN_TEXT = Object.freeze([
  phrase("OM", "P"),
  phrase("Oh ", "My Pi"),
  phrase("Theme ", "Seven"),
  phrase("T", "4"),
  phrase("hosted ", "platform"),
  phrase("release ", "train"),
  phrase("Act", "ivity"),
  phrase("Session ", "History"),
])

const forbidden = STOCK_FORBIDDEN_TEXT.map((value) => ({
  value,
  pattern: new RegExp(`\\b${value.replaceAll(" ", "\\s+")}\\b`, value === "OMP" || value === "T4" ? "" : "i"),
}))

function finding(relative, index, match, line) {
  return {
    category: "stock-brand-boundary",
    path: relative,
    line: index + 1,
    pattern: match.value,
    source: line.trim(),
  }
}

export function scanStockSurfaceFile(relative, source) {
  const findings = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = forbidden.find(({ pattern }) => pattern.test(line))
    if (match) findings.push(finding(relative, index, match, line))
  }
  return findings
}

export function collectStockSurfaceFindings(sources) {
  return Object.entries(sources).flatMap(([relative, source]) => scanStockSurfaceFile(relative, source))
}

export function checkPublicSurface(sources) {
  const findings = collectStockSurfaceFindings(sources)
  if (findings.length) {
    throw new Error(`Stock surface exposes integration-only concepts:\n${findings.map((finding) => `${finding.path}:${finding.line}: ${finding.pattern}`).join("\n")}`)
  }
  return { fileCount: Object.keys(sources).length }
}

function readStockSurface(rootDirectory) {
  return Object.fromEntries(stockSurfaceFiles.map((relative) => [
    relative,
    fs.readFileSync(path.join(rootDirectory, relative), "utf8"),
  ]))
}

function isDirectCli() {
  return path.basename(process.argv[1] ?? "") === "check-public-surface.mjs"
}

if (isDirectCli()) {
  const result = checkPublicSurface(readStockSurface(root))
  process.stdout.write(`Stock brand boundary clean (${result.fileCount} files).\n`)
}
