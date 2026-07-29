import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { isPathInside } from "@/lib/path-containment"

const MAX_RELATIVE_PATH = 2_048
const MAX_ASSET_BYTES = 25 * 1024 * 1024
const MAX_FINGERPRINT_FILES = 512
const MAX_FINGERPRINT_DEPTH = 16
const FINGERPRINT_IGNORED_DIRECTORIES = new Set(["node_modules"])

const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
])

const CREDENTIAL_NAMES = new Set([
  "credentials.json",
  "secrets.json",
  "service-account.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
])


function pathParts(value: string): string[] {
  if (!value || value.length > MAX_RELATIVE_PATH || value.includes("\0") || value.includes("\\")) {
    throw new Error("Choose a valid lane-relative path.")
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new Error("Absolute paths are not supported.")
  const parts = value.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Path traversal is not supported.")
  return parts
}

function isSensitivePart(part: string): boolean {
  const lower = part.toLowerCase()
  return lower.startsWith(".") || CREDENTIAL_NAMES.has(lower) || lower.endsWith(".pem") || lower.endsWith(".key") || lower.endsWith(".p12") || lower.endsWith(".pfx")
}

function rejectSensitivePart(part: string): void {
  if (!isSensitivePart(part)) return
  if (part.startsWith(".")) throw new Error("Hidden files are not available to Web Preview.")
  throw new Error("Credential-like files are not available to Web Preview.")
}

export function normalizeWebPreviewEntry(input: string): string {
  const normalized = input.trim().replaceAll("\\", "/")
  const parts = pathParts(normalized)
  for (const part of parts) rejectSensitivePart(part)
  if (path.posix.extname(parts.at(-1)!).toLowerCase() !== ".html") {
    throw new Error("Web Preview opens .html entry files only.")
  }
  return parts.join("/")
}

export function encodeWebPreviewRoot(relativeDirectory: string): string {
  const normalized = relativeDirectory === "." ? "." : pathParts(relativeDirectory).join("/")
  return Buffer.from(normalized, "utf8").toString("base64url")
}

export function decodeWebPreviewRoot(encoded: string): string {
  if (!/^[A-Za-z0-9_-]{1,2800}$/.test(encoded)) throw new Error("Invalid preview root.")
  const decoded = Buffer.from(encoded, "base64url").toString("utf8")
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) throw new Error("Invalid preview root.")
  return decoded === "." ? "." : pathParts(decoded).join("/")
}

async function rejectSymlinks(root: string, parts: string[]): Promise<void> {
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not available to Web Preview.")
  }
}

export async function resolveWebPreviewAsset(
  laneRoot: string,
  encodedRoot: string,
  assetPath: string
): Promise<{ absolutePath: string; contentType: string; size: number }> {
  const canonicalLane = await fs.realpath(laneRoot)
  const relativeRoot = decodeWebPreviewRoot(encodedRoot)
  const rootParts = relativeRoot === "." ? [] : pathParts(relativeRoot)
  const assetParts = pathParts(assetPath)
  for (const part of [...rootParts, ...assetParts]) rejectSensitivePart(part)

  await rejectSymlinks(canonicalLane, rootParts)
  const previewRoot = path.resolve(canonicalLane, ...rootParts)
  if (!isPathInside(canonicalLane, previewRoot)) throw new Error("Preview root escapes the lane directory.")
  const rootStat = await fs.stat(previewRoot)
  if (!rootStat.isDirectory()) throw new Error("Preview root is not a directory.")

  await rejectSymlinks(previewRoot, assetParts)
  const candidate = path.resolve(previewRoot, ...assetParts)
  if (!isPathInside(previewRoot, candidate)) throw new Error("Preview asset escapes its entry directory.")
  const canonical = await fs.realpath(candidate)
  if (!isPathInside(previewRoot, canonical)) throw new Error("Preview asset escapes its entry directory.")
  const stat = await fs.stat(canonical)
  if (!stat.isFile()) throw new Error("Preview asset is not a file.")
  if (stat.size > MAX_ASSET_BYTES) throw new Error("Preview asset is too large.")
  const extension = path.extname(canonical).toLowerCase()
  const contentType = CONTENT_TYPES.get(extension)
  if (!contentType) throw new Error("This file type is not available to Web Preview.")
  return { absolutePath: canonical, contentType, size: stat.size }
}

export async function validateWebPreviewEntry(
  laneRoot: string,
  input: string
): Promise<{ entryPath: string; encodedRoot: string; entryFile: string }> {
  const entryPath = normalizeWebPreviewEntry(input)
  const root = path.posix.dirname(entryPath)
  const entryFile = path.posix.basename(entryPath)
  const encodedRoot = encodeWebPreviewRoot(root)
  await resolveWebPreviewAsset(laneRoot, encodedRoot, entryFile)
  return { entryPath, encodedRoot, entryFile }
}

export async function fingerprintWebPreviewRoot(laneRoot: string, input: string): Promise<string> {
  const selected = await validateWebPreviewEntry(laneRoot, input)
  const canonicalLane = await fs.realpath(laneRoot)
  const relativeRoot = path.posix.dirname(selected.entryPath)
  const rootParts = relativeRoot === "." ? [] : pathParts(relativeRoot)
  await rejectSymlinks(canonicalLane, rootParts)
  const previewRoot = path.resolve(canonicalLane, ...rootParts)
  if (!isPathInside(canonicalLane, previewRoot)) throw new Error("Preview root escapes the lane directory.")

  const records: string[] = []
  async function walk(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > MAX_FINGERPRINT_DEPTH) throw new Error("Web Preview live refresh reached its directory depth limit.")
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (isSensitivePart(entry.name) || entry.isSymbolicLink()) continue
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (FINGERPRINT_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue
        await walk(absolute, relative, depth + 1)
        continue
      }
      if (!entry.isFile() || !CONTENT_TYPES.has(path.extname(entry.name).toLowerCase())) continue
      if (records.length >= MAX_FINGERPRINT_FILES) throw new Error(`Web Preview live refresh supports up to ${MAX_FINGERPRINT_FILES} static files.`)
      const stat = await fs.stat(absolute, { bigint: true })
      if (stat.size > BigInt(MAX_ASSET_BYTES)) continue
      records.push(`${relative}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`)
    }
  }
  await walk(previewRoot, "", 0)
  return createHash("sha256").update(records.join("\n")).digest("base64url")
}

export function previewResponseHeaders(contentType: string): Headers {
  const headers = new Headers({
    "cache-control": "no-store, max-age=0",
    "content-type": contentType,
    "cross-origin-resource-policy": "cross-origin",
    "permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })
  if (contentType.startsWith("text/javascript") || contentType.startsWith("application/json")) {
    headers.set("access-control-allow-origin", "*")
  }
  if (contentType.startsWith("text/html")) {
    headers.set("content-security-policy", [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'none'",
      "form-action 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "frame-src 'none'",
      "child-src 'none'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "manifest-src 'none'",
      "navigate-to 'none'",
    ].join("; "))
  }
  return headers
}

export const webPreviewInternals = { MAX_ASSET_BYTES, MAX_FINGERPRINT_FILES, MAX_FINGERPRINT_DEPTH }
