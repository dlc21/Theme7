import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { activeEditionPath, configuredValue, editionsDirectory } from "@/lib/config"
import { isPathInside } from "@/lib/path-containment"

export const EDITION_SURFACES = ["product-mark", "product-name", "product-subtitle", "agent-card:omp", "agent-card:codex", "agent-card:shell", "onboarding", "pane-palette"] as const
export type EditionSurfaceId = typeof EDITION_SURFACES[number]
export type EditionSurfaceOverride = { label?: string; description?: string; badge?: string; icon?: string; background?: string; decoration?: string; decorations?: string[]; visibility?: "visible" | "hidden"; interaction?: "default" | "display-only" }
export type EditionTerms = { workItem?: { singular?: string; plural?: string } }
export const EDITION_WALKTHROUGH_TARGETS = ["job-list", "operator", "local-sessions", "workspace-state"] as const
export type EditionWalkthroughTarget = typeof EDITION_WALKTHROUGH_TARGETS[number]
export type EditionWalkthroughStepV1 = { id: string; target?: EditionWalkthroughTarget; title: string; description: string }
export type EditionWalkthroughV1 = { version: string; entryLabel: string; replayLabel: string; steps: EditionWalkthroughStepV1[] }
export type EditionWalkthroughPublic = EditionWalkthroughV1

export type TerminalShowpiecePointV1 = { x: number; y: number }
export type TerminalShowpiecePrimitiveV1 =
  | { kind: "field"; pattern: "square-grid" | "dot-grid" | "scan-lines"; columns: number; rows: number; atMs: number; durationMs: number }
  | { kind: "node"; shape: "square" | "circle" | "diamond"; x: number; y: number; size: number; atMs: number; durationMs: number; motion: "fade" | "pop" | "settle"; tone: "muted" | "accent" | "strong" }
  | { kind: "path"; points: TerminalShowpiecePointV1[]; atMs: number; durationMs: number; motion: "draw" | "signal"; tone: "muted" | "accent" | "strong" }
  | { kind: "ring"; x: number; y: number; size: number; atMs: number; durationMs: number; tone: "muted" | "accent" | "strong" }
  | { kind: "text"; value: string; variant: "loader" | "display" | "caption"; x: number; y: number; atMs: number; durationMs: number; motion: "fade" | "settle"; tone: "muted" | "accent" | "strong" }
  | { kind: "mark"; asset: string; x: number; y: number; width: number; height: number; atMs: number; durationMs: number; motion: "fade" | "pop" }
export type TerminalShowpieceExperienceV1 = { id: string; durationMs: number; primitives: TerminalShowpiecePrimitiveV1[] }
export type TerminalShowpieceV1 = { version: 1; mode: "append" | "replace"; experiences: TerminalShowpieceExperienceV1[] }
export type TerminalShowpieceMarkPublicV1 = Omit<Extract<TerminalShowpiecePrimitiveV1, { kind: "mark" }>, "asset"> & { assetUrl: string }
export type TerminalShowpiecePrimitivePublicV1 = Exclude<TerminalShowpiecePrimitiveV1, { kind: "mark" }> | TerminalShowpieceMarkPublicV1
export type TerminalShowpieceExperiencePublicV1 = Omit<TerminalShowpieceExperienceV1, "primitives"> & { primitives: TerminalShowpiecePrimitivePublicV1[] }
export type TerminalShowpiecePublicV1 = Omit<TerminalShowpieceV1, "experiences"> & { experiences: TerminalShowpieceExperiencePublicV1[] }

export type EditionManifestV1 = {
  schemaVersion: 1
  id: string
  name: string
  description: string
  brand?: { productName?: string; subtitle?: string; icon?: string; favicon?: string }
  terms?: EditionTerms
  surfaces?: Partial<Record<EditionSurfaceId, EditionSurfaceOverride>>
  onboarding?: { image?: string; video?: string; walkthrough?: EditionWalkthroughV1 }
  stylesheet?: string
  terminalShowpiece?: TerminalShowpieceV1
}
export type EditionSource = "builtin" | "local" | "environment"
export type LoadedEdition = EditionManifestV1 & { source: EditionSource; root: string }
export type EditionSummary = Pick<EditionManifestV1, "id" | "name" | "description"> & { source: EditionSource }
export type ActiveEditionPublic = Omit<EditionManifestV1, "brand" | "surfaces" | "onboarding" | "stylesheet" | "terminalShowpiece"> & {
  source: EditionSource
  brand?: { productName?: string; subtitle?: string; iconUrl?: string; faviconUrl?: string }
  surfaces?: Partial<Record<EditionSurfaceId, Omit<EditionSurfaceOverride, "icon" | "background" | "decoration" | "decorations"> & { iconUrl?: string; backgroundUrl?: string; decorationUrl?: string; decorationUrls?: string[] }>>
  onboarding?: { imageUrl?: string; videoUrl?: string; walkthrough?: EditionWalkthroughPublic }
  stylesheetUrl?: string
  terminalShowpiece?: TerminalShowpiecePublicV1
}
export type EditionState = { active: ActiveEditionPublic | null; activeId: string; lastEditionId?: string; locked: boolean; editions: EditionSummary[]; error?: string }
export type EditionSurfacePublic = NonNullable<NonNullable<ActiveEditionPublic["surfaces"]>[EditionSurfaceId]>

export function mergeEditionSurface(edition: ActiveEditionPublic | null, id: EditionSurfaceId, stock: EditionSurfacePublic): EditionSurfacePublic {
  const override = Object.fromEntries(Object.entries(edition?.surfaces?.[id] ?? {}).filter(([, value]) => value !== undefined)) as EditionSurfacePublic
  return { ...stock, ...override }
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const KEYS: Record<string, true> = { schemaVersion: true, id: true, name: true, description: true, brand: true, terms: true, surfaces: true, onboarding: true, stylesheet: true, terminalShowpiece: true }
const BRAND_KEYS: Record<string, true> = { productName: true, subtitle: true, icon: true, favicon: true }
const TERMS_KEYS: Record<string, true> = { workItem: true }
const WORK_ITEM_KEYS: Record<string, true> = { singular: true, plural: true }
const SURFACE_KEYS: Record<string, true> = { label: true, description: true, badge: true, icon: true, background: true, decoration: true, decorations: true, visibility: true, interaction: true }
const ONBOARDING_KEYS: Record<string, true> = { image: true, video: true, walkthrough: true }
const WALKTHROUGH_KEYS: Record<string, true> = { version: true, entryLabel: true, replayLabel: true, steps: true }
const WALKTHROUGH_STEP_KEYS: Record<string, true> = { id: true, target: true, title: true, description: true }
const TERMINAL_SHOWPIECE_KEYS: Record<string, true> = { version: true, mode: true, experiences: true }
const TERMINAL_SHOWPIECE_EXPERIENCE_KEYS: Record<string, true> = { id: true, durationMs: true, primitives: true }
const TERMINAL_SHOWPIECE_PRIMITIVE_KEYS: Record<string, Record<string, true>> = {
  field: { kind: true, pattern: true, columns: true, rows: true, atMs: true, durationMs: true },
  node: { kind: true, shape: true, x: true, y: true, size: true, atMs: true, durationMs: true, motion: true, tone: true },
  path: { kind: true, points: true, atMs: true, durationMs: true, motion: true, tone: true },
  ring: { kind: true, x: true, y: true, size: true, atMs: true, durationMs: true, tone: true },
  mark: { kind: true, asset: true, x: true, y: true, width: true, height: true, atMs: true, durationMs: true, motion: true },
  text: { kind: true, value: true, variant: true, x: true, y: true, atMs: true, durationMs: true, motion: true, tone: true },
}
const TERMINAL_SHOWPIECE_POINT_KEYS: Record<string, true> = { x: true, y: true }
const WALKTHROUGH_VERSION = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const WALKTHROUGH_TARGETS = Object.fromEntries(EDITION_WALKTHROUGH_TARGETS.map((target) => [target, true])) as Record<EditionWalkthroughTarget, true>
const SURFACES = Object.fromEntries(EDITION_SURFACES.map((surface) => [surface, true])) as Record<EditionSurfaceId, true>
const ASSET_EXTENSIONS: Record<string, true> = { ".css": true, ".svg": true, ".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true, ".ico": true, ".mp4": true, ".webm": true }
const MAX_ASSET_BYTES = 25 * 1024 * 1024
const MAX_CSS_BYTES = 256 * 1024
const MAX_SVG_BYTES = 1024 * 1024

function builtinRoot(): string { return path.join(process.cwd(), "editions", "builtin") }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) }
function safeText(value: unknown, label: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`Edition ${label} ${required ? "is required" : "must be a non-empty string"}.`)
  if (value.length > 240) throw new Error(`Edition ${label} is too long.`)
  return value.trim()
}
function safeAsset(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.split(/[\\/]/).includes("..") || /^[a-z]+:/i.test(value) || value.startsWith("//")) throw new Error(`Edition ${label} must be a safe relative asset path.`)
  const normalized = value.replaceAll("\\", "/")
  if (!Object.hasOwn(ASSET_EXTENSIONS, path.extname(normalized).toLowerCase())) throw new Error(`Edition ${label} has an unsupported asset type.`)
  return normalized
}
function unknownKeys(value: Record<string, unknown>, allowed: Record<string, true>, label: string) {
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(allowed, key)); if (unknown.length) throw new Error(`Unknown ${label} fields: ${unknown.join(", ")}.`)
}

function safeWalkthroughTarget(value: unknown, label: string): EditionWalkthroughTarget {
  if (typeof value !== "string" || !Object.hasOwn(WALKTHROUGH_TARGETS, value)) throw new Error(`Edition ${label} is not supported.`)
  return value as EditionWalkthroughTarget
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`Edition ${label} must be an integer from ${minimum} through ${maximum}.`)
  return value as number
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`Edition ${label} is invalid.`)
  return value as T
}

function validateTerminalShowpiece(value: unknown): TerminalShowpieceV1 {
  if (!isRecord(value)) throw new Error("Edition terminalShowpiece must be an object.")
  unknownKeys(value, TERMINAL_SHOWPIECE_KEYS, "terminalShowpiece")
  if (value.version !== 1) throw new Error("Edition terminalShowpiece.version must be 1.")
  const mode = oneOf(value.mode, ["append", "replace"], "terminalShowpiece.mode")
  if (!Array.isArray(value.experiences) || value.experiences.length < 1 || value.experiences.length > 12) throw new Error("Edition terminalShowpiece.experiences must contain one to twelve experiences.")
  const ids = new Set<string>()
  const experiences = value.experiences.map((rawExperience, experienceIndex): TerminalShowpieceExperienceV1 => {
    const label = `terminalShowpiece.experiences[${experienceIndex}]`
    if (!isRecord(rawExperience)) throw new Error(`Edition ${label} must be an object.`)
    unknownKeys(rawExperience, TERMINAL_SHOWPIECE_EXPERIENCE_KEYS, label)
    const id = safeText(rawExperience.id, `${label}.id`, true)!
    if (!ID.test(id)) throw new Error(`Edition ${label}.id must be lowercase kebab-case.`)
    if (ids.has(id)) throw new Error(`Edition terminalShowpiece experience id ${id} must be unique.`)
    ids.add(id)
    const durationMs = boundedInteger(rawExperience.durationMs, 4000, 7000, `${label}.durationMs`)
    if (!Array.isArray(rawExperience.primitives) || rawExperience.primitives.length < 1 || rawExperience.primitives.length > 64) throw new Error(`Edition ${label}.primitives must contain one to 64 primitives.`)
    const primitives = rawExperience.primitives.map((rawPrimitive, primitiveIndex): TerminalShowpiecePrimitiveV1 => {
      const primitiveLabel = `${label}.primitives[${primitiveIndex}]`
      if (!isRecord(rawPrimitive) || typeof rawPrimitive.kind !== "string" || !Object.hasOwn(TERMINAL_SHOWPIECE_PRIMITIVE_KEYS, rawPrimitive.kind)) throw new Error(`Edition ${primitiveLabel}.kind is invalid.`)
      unknownKeys(rawPrimitive, TERMINAL_SHOWPIECE_PRIMITIVE_KEYS[rawPrimitive.kind], primitiveLabel)
      const atMs = boundedInteger(rawPrimitive.atMs, 0, durationMs, `${primitiveLabel}.atMs`)
      const primitiveDurationMs = boundedInteger(rawPrimitive.durationMs, 0, durationMs, `${primitiveLabel}.durationMs`)
      if (atMs + primitiveDurationMs > durationMs) throw new Error(`Edition ${primitiveLabel} timing exceeds its experience duration.`)
      const coordinate = (name: "x" | "y") => boundedInteger(rawPrimitive[name], 0, 1000, `${primitiveLabel}.${name}`)
      const size = (name: "size" | "width" | "height") => boundedInteger(rawPrimitive[name], 1, 1000, `${primitiveLabel}.${name}`)
      if (rawPrimitive.kind === "field") return { kind: "field", pattern: oneOf(rawPrimitive.pattern, ["square-grid", "dot-grid", "scan-lines"], `${primitiveLabel}.pattern`), columns: boundedInteger(rawPrimitive.columns, 2, 20, `${primitiveLabel}.columns`), rows: boundedInteger(rawPrimitive.rows, 2, 20, `${primitiveLabel}.rows`), atMs, durationMs: primitiveDurationMs }
      if (rawPrimitive.kind === "node") return { kind: "node", shape: oneOf(rawPrimitive.shape, ["square", "circle", "diamond"], `${primitiveLabel}.shape`), x: coordinate("x"), y: coordinate("y"), size: size("size"), atMs, durationMs: primitiveDurationMs, motion: oneOf(rawPrimitive.motion, ["fade", "pop", "settle"], `${primitiveLabel}.motion`), tone: oneOf(rawPrimitive.tone, ["muted", "accent", "strong"], `${primitiveLabel}.tone`) }
      if (rawPrimitive.kind === "ring") return { kind: "ring", x: coordinate("x"), y: coordinate("y"), size: size("size"), atMs, durationMs: primitiveDurationMs, tone: oneOf(rawPrimitive.tone, ["muted", "accent", "strong"], `${primitiveLabel}.tone`) }
      if (rawPrimitive.kind === "text") return { kind: "text", value: safeText(rawPrimitive.value, `${primitiveLabel}.value`, true)!, variant: oneOf(rawPrimitive.variant, ["loader", "display", "caption"], `${primitiveLabel}.variant`), x: coordinate("x"), y: coordinate("y"), atMs, durationMs: primitiveDurationMs, motion: oneOf(rawPrimitive.motion, ["fade", "settle"], `${primitiveLabel}.motion`), tone: oneOf(rawPrimitive.tone, ["muted", "accent", "strong"], `${primitiveLabel}.tone`) }
      if (rawPrimitive.kind === "mark") return { kind: "mark", asset: safeAsset(rawPrimitive.asset, `${primitiveLabel}.asset`)!, x: coordinate("x"), y: coordinate("y"), width: size("width"), height: size("height"), atMs, durationMs: primitiveDurationMs, motion: oneOf(rawPrimitive.motion, ["fade", "pop"], `${primitiveLabel}.motion`) }
      if (!Array.isArray(rawPrimitive.points) || rawPrimitive.points.length < 2 || rawPrimitive.points.length > 8) throw new Error(`Edition ${primitiveLabel}.points must contain two to eight points.`)
      const points = rawPrimitive.points.map((rawPoint, pointIndex): TerminalShowpiecePointV1 => {
        if (!isRecord(rawPoint)) throw new Error(`Edition ${primitiveLabel}.points[${pointIndex}] must be an object.`)
        unknownKeys(rawPoint, TERMINAL_SHOWPIECE_POINT_KEYS, `${primitiveLabel}.points[${pointIndex}]`)
        return { x: boundedInteger(rawPoint.x, 0, 1000, `${primitiveLabel}.points[${pointIndex}].x`), y: boundedInteger(rawPoint.y, 0, 1000, `${primitiveLabel}.points[${pointIndex}].y`) }
      })
      return { kind: "path", points, atMs, durationMs: primitiveDurationMs, motion: oneOf(rawPrimitive.motion, ["draw", "signal"], `${primitiveLabel}.motion`), tone: oneOf(rawPrimitive.tone, ["muted", "accent", "strong"], `${primitiveLabel}.tone`) }
    })
    return { id, durationMs, primitives }
  })
  return { version: 1, mode, experiences }
}

export function validateEditionManifest(value: unknown): EditionManifestV1 {
  if (!isRecord(value)) throw new Error("Edition manifest must be an object.")
  unknownKeys(value, KEYS, "Edition")
  if (value.schemaVersion !== 1) throw new Error("Edition schemaVersion must be 1.")
  const id = safeText(value.id, "id", true)!
  if (!ID.test(id)) throw new Error("Edition id must be lowercase kebab-case.")
  const manifest: EditionManifestV1 = { schemaVersion: 1, id, name: safeText(value.name, "name", true)!, description: safeText(value.description, "description", true)! }
  if (value.brand !== undefined) {
    if (!isRecord(value.brand)) throw new Error("Edition brand must be an object.")
    unknownKeys(value.brand, BRAND_KEYS, "brand")
    manifest.brand = { productName: safeText(value.brand.productName, "brand.productName"), subtitle: safeText(value.brand.subtitle, "brand.subtitle"), icon: safeAsset(value.brand.icon, "brand.icon"), favicon: safeAsset(value.brand.favicon, "brand.favicon") }
  }
  if (value.terms !== undefined) {
    if (!isRecord(value.terms)) throw new Error("Edition terms must be an object.")
    unknownKeys(value.terms, TERMS_KEYS, "terms")
    manifest.terms = {}
    if (value.terms.workItem !== undefined) {
      if (!isRecord(value.terms.workItem)) throw new Error("Edition terms.workItem must be an object.")
      unknownKeys(value.terms.workItem, WORK_ITEM_KEYS, "terms.workItem")
      manifest.terms.workItem = {
        singular: safeText(value.terms.workItem.singular, "terms.workItem.singular"),
        plural: safeText(value.terms.workItem.plural, "terms.workItem.plural"),
      }
    }
  }
  if (value.surfaces !== undefined) {
    if (!isRecord(value.surfaces)) throw new Error("Edition surfaces must be an object.")
    manifest.surfaces = {}
    for (const [id, raw] of Object.entries(value.surfaces)) {
      if (!Object.hasOwn(SURFACES, id) || !isRecord(raw)) throw new Error(`Edition surface ${id} is not supported.`)
      unknownKeys(raw, SURFACE_KEYS, `surface ${id}`)
      if (raw.visibility !== undefined && raw.visibility !== "visible" && raw.visibility !== "hidden") throw new Error(`Edition surface ${id} visibility is invalid.`)
      if (raw.interaction !== undefined && raw.interaction !== "default" && raw.interaction !== "display-only") throw new Error(`Edition surface ${id} interaction is invalid.`)
      if (raw.decorations !== undefined && (!Array.isArray(raw.decorations) || raw.decorations.length > 4)) throw new Error(`Edition surface ${id}.decorations must contain at most four assets.`)
      manifest.surfaces[id as EditionSurfaceId] = { label: safeText(raw.label, `${id}.label`), description: safeText(raw.description, `${id}.description`), badge: safeText(raw.badge, `${id}.badge`), icon: safeAsset(raw.icon, `${id}.icon`), background: safeAsset(raw.background, `${id}.background`), decoration: safeAsset(raw.decoration, `${id}.decoration`), decorations: Array.isArray(raw.decorations) ? raw.decorations.map((asset, index) => safeAsset(asset, `${id}.decorations[${index}]`)!) : undefined, visibility: raw.visibility as EditionSurfaceOverride["visibility"], interaction: raw.interaction as EditionSurfaceOverride["interaction"] }
    }
  }
  if (value.onboarding !== undefined) {
    if (!isRecord(value.onboarding)) throw new Error("Edition onboarding must be an object.")
    unknownKeys(value.onboarding, ONBOARDING_KEYS, "onboarding")
    manifest.onboarding = { image: safeAsset(value.onboarding.image, "onboarding.image"), video: safeAsset(value.onboarding.video, "onboarding.video") }
    if (value.onboarding.walkthrough !== undefined) {
      if (!isRecord(value.onboarding.walkthrough)) throw new Error("Edition onboarding.walkthrough must be an object.")
      const rawWalkthrough = value.onboarding.walkthrough
      unknownKeys(rawWalkthrough, WALKTHROUGH_KEYS, "onboarding.walkthrough")
      const version = safeText(rawWalkthrough.version, "onboarding.walkthrough.version", true)!
      if (!WALKTHROUGH_VERSION.test(version)) throw new Error("Edition onboarding.walkthrough.version is invalid.")
      if (!Array.isArray(rawWalkthrough.steps) || rawWalkthrough.steps.length < 2 || rawWalkthrough.steps.length > 5) throw new Error("Edition onboarding.walkthrough.steps must contain two to five steps.")
      const ids = new Set<string>()
      const steps = rawWalkthrough.steps.map((rawStep, index): EditionWalkthroughStepV1 => {
        if (!isRecord(rawStep)) throw new Error(`Edition onboarding.walkthrough.steps[${index}] must be an object.`)
        unknownKeys(rawStep, WALKTHROUGH_STEP_KEYS, `onboarding.walkthrough.steps[${index}]`)
        const stepId = safeText(rawStep.id, `onboarding.walkthrough.steps[${index}].id`, true)!
        if (!ID.test(stepId)) throw new Error(`Edition onboarding.walkthrough.steps[${index}].id must be lowercase kebab-case.`)
        if (ids.has(stepId)) throw new Error(`Edition onboarding.walkthrough step id ${stepId} must be unique.`)
        ids.add(stepId)
        return {
          id: stepId,
          target: rawStep.target === undefined ? undefined : safeWalkthroughTarget(rawStep.target, `onboarding.walkthrough.steps[${index}].target`),
          title: safeText(rawStep.title, `onboarding.walkthrough.steps[${index}].title`, true)!,
          description: safeText(rawStep.description, `onboarding.walkthrough.steps[${index}].description`, true)!,
        }
      })
      manifest.onboarding.walkthrough = {
        version,
        entryLabel: safeText(rawWalkthrough.entryLabel, "onboarding.walkthrough.entryLabel", true)!,
        replayLabel: safeText(rawWalkthrough.replayLabel, "onboarding.walkthrough.replayLabel", true)!,
        steps,
      }
    }
  }
  if (value.terminalShowpiece !== undefined) manifest.terminalShowpiece = validateTerminalShowpiece(value.terminalShowpiece)
  manifest.stylesheet = safeAsset(value.stylesheet, "stylesheet")
  return manifest
}

export function declaredEditionAssets(manifest: EditionManifestV1): string[] {
  return [manifest.brand?.icon, manifest.brand?.favicon, manifest.onboarding?.image, manifest.onboarding?.video, manifest.stylesheet,
    ...Object.values(manifest.surfaces ?? {}).flatMap((surface) => [surface?.icon, surface?.background, surface?.decoration, ...(surface?.decorations ?? [])]),
    ...manifest.terminalShowpiece?.experiences.flatMap((experience) => experience.primitives.flatMap((primitive) => primitive.kind === "mark" ? [primitive.asset] : [])) ?? []].filter((value): value is string => Boolean(value))
}
async function validateAsset(root: string, relative: string): Promise<void> {
  const target = path.resolve(root, relative)
  if (!isPathInside(root, target)) throw new Error(`Edition asset ${relative} escapes its folder.`)
  const stat = await fs.lstat(target)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Edition asset ${relative} must be a regular file.`)
  if (stat.size > MAX_ASSET_BYTES) throw new Error(`Edition asset ${relative} exceeds 25 MB.`)
  const extension = path.extname(relative).toLowerCase()
  if (extension === ".css" && stat.size > MAX_CSS_BYTES) throw new Error(`Edition stylesheet ${relative} exceeds 256 KB.`)
  if (extension === ".svg" && stat.size > MAX_SVG_BYTES) throw new Error(`Edition SVG ${relative} exceeds 1 MB.`)
  const realRoot = await fs.realpath(root); const realTarget = await fs.realpath(target)
  if (!isPathInside(realRoot, realTarget)) throw new Error(`Edition asset ${relative} escapes through a link.`)
  if (extension === ".css") {
    const css = await fs.readFile(realTarget, "utf8")
    if (/@import\b/i.test(css) || /url\(\s*["']?(?:[a-z]+:|\/\/)/i.test(css) || /javascript\s*:/i.test(css) || /expression\s*\(/i.test(css)) throw new Error("Edition CSS may reference local relative assets only.")
  }
  if (extension === ".svg") {
    const svg = await fs.readFile(realTarget, "utf8")
    if (/<(?:script|foreignObject)\b/i.test(svg) || /\son[a-z]+\s*=/i.test(svg) || /(?:javascript|data)\s*:/i.test(svg) || /(?:href|xlink:href)\s*=\s*["']\s*(?:[a-z]+:|\/\/)/i.test(svg) || /@import\b/i.test(svg) || /url\(\s*["']?(?:[a-z]+:|\/\/)/i.test(svg)) throw new Error(`Edition SVG ${relative} contains executable or remote content.`)
  }
}
async function loadFolder(folder: string, source: EditionSource): Promise<LoadedEdition> {
  const root = path.resolve(folder); const stat = await fs.lstat(root)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Edition folder must be a real directory.")
  const manifestPath = path.join(root, "edition.json"); const manifestStat = await fs.lstat(manifestPath)
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error("Edition manifest must be a regular file.")
  const manifest = validateEditionManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")))
  await Promise.all(declaredEditionAssets(manifest).map((asset) => validateAsset(root, asset)))
  return { ...manifest, source, root }
}
async function folders(root: string): Promise<string[]> {
  await fs.mkdir(root, { recursive: true })
  return (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => path.join(root, entry.name)).sort()
}
export async function loadEditions(): Promise<LoadedEdition[]> {
  const builtins = await Promise.all((await folders(builtinRoot())).map((folder) => loadFolder(folder, "builtin")))
  const local: LoadedEdition[] = []; const seen = new Set(builtins.map((edition) => edition.id))
  for (const folder of await folders(editionsDirectory())) { const edition = await loadFolder(folder, "local"); if (seen.has(edition.id)) throw new Error(`Duplicate Edition id ${edition.id}.`); seen.add(edition.id); local.push(edition) }
  return [...builtins, ...local]
}
function assetUrl(relative: string): string { return `/api/editions/assets/${relative.split("/").map(encodeURIComponent).join("/")}` }
export function publicEditionFromManifest(manifest: EditionManifestV1, source: ActiveEditionPublic["source"]): ActiveEditionPublic {
  return { schemaVersion: 1, id: manifest.id, name: manifest.name, description: manifest.description, source,
    brand: manifest.brand ? { productName: manifest.brand.productName, subtitle: manifest.brand.subtitle, iconUrl: manifest.brand.icon ? assetUrl(manifest.brand.icon) : undefined, faviconUrl: manifest.brand.favicon ? assetUrl(manifest.brand.favicon) : undefined } : undefined,
    terms: manifest.terms,
    surfaces: manifest.surfaces ? Object.fromEntries(Object.entries(manifest.surfaces).map(([id, surface]) => {
      if (!surface) return [id, surface]
      const { icon, background, decoration, decorations, ...presentation } = surface
      return [id, { ...presentation, iconUrl: icon ? assetUrl(icon) : undefined, backgroundUrl: background ? assetUrl(background) : undefined, decorationUrl: decoration ? assetUrl(decoration) : undefined, decorationUrls: decorations?.map(assetUrl) }]
    })) : undefined,
    onboarding: manifest.onboarding ? {
      imageUrl: manifest.onboarding.image ? assetUrl(manifest.onboarding.image) : undefined,
      videoUrl: manifest.onboarding.video ? assetUrl(manifest.onboarding.video) : undefined,
      walkthrough: manifest.onboarding.walkthrough,
    } : undefined,
    terminalShowpiece: manifest.terminalShowpiece ? { ...manifest.terminalShowpiece, experiences: manifest.terminalShowpiece.experiences.map((experience) => ({ ...experience, primitives: experience.primitives.map((primitive) => primitive.kind === "mark" ? (({ asset, ...mark }) => ({ ...mark, assetUrl: assetUrl(asset) }))(primitive) : primitive) })) } : undefined,
    stylesheetUrl: manifest.stylesheet ? "/api/editions/assets/theme.css" : undefined,
  }
}
type EditionSelection = { editionId: string; lastEditionId?: string }
async function editionSelection(): Promise<EditionSelection> {
  try {
    const value = JSON.parse(await fs.readFile(activeEditionPath(), "utf8")) as { editionId?: unknown; lastEditionId?: unknown }
    const editionId = typeof value.editionId === "string" ? value.editionId : "stock"
    const lastEditionId = typeof value.lastEditionId === "string" ? value.lastEditionId : editionId !== "stock" ? editionId : undefined
    return { editionId, ...(lastEditionId ? { lastEditionId } : {}) }
  } catch { return { editionId: "stock" } }
}
export async function activeEditionInternal(): Promise<{ edition: LoadedEdition | null; error?: string; locked: boolean }> {
  const environment = configuredValue("EDITION_DIR")?.trim()
  if (environment) {
    try { return { edition: await loadFolder(environment, "environment"), locked: true } }
    catch (error) { return { edition: null, locked: true, error: error instanceof Error ? error.message : "Environment Edition is invalid." } }
  }
  try {
    const { editionId: id } = await editionSelection(); if (id === "stock") return { edition: null, locked: false }
    const edition = (await loadEditions()).find((item) => item.id === id)
    return edition ? { edition, locked: false } : { edition: null, locked: false, error: `Edition ${id} is missing; Stock is active.` }
  } catch (error) { return { edition: null, locked: false, error: error instanceof Error ? error.message : "Active Edition is invalid." } }
}
export async function editionState(): Promise<EditionState> {
  const active = await activeEditionInternal()
  const selection = await editionSelection()
  let editions: EditionSummary[] = []
  try { editions = (await loadEditions()).map(({ id, name, description, source }) => ({ id, name, description, source })) } catch (error) { active.error ??= error instanceof Error ? error.message : "Unable to load Editions." }
  return { active: active.edition ? publicEditionFromManifest(active.edition, active.edition.source) : null, activeId: active.edition?.id ?? "stock", ...(selection.lastEditionId ? { lastEditionId: selection.lastEditionId } : {}), locked: active.locked, editions, ...(active.error ? { error: active.error } : {}) }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const stamp = `${process.pid}.${Date.now()}`
  const temporary = `${file}.${stamp}.tmp`
  const backup = `${file}.${stamp}.bak`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  let hadTarget = false
  try { await fs.rename(file, backup); hadTarget = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await fs.rm(temporary, { force: true }); throw error }
  }
  try { await fs.rename(temporary, file); if (hadTarget) await fs.rm(backup, { force: true }) }
  catch (error) { if (hadTarget) await fs.rename(backup, file).catch(() => undefined); await fs.rm(temporary, { force: true }); throw error }
}
export async function selectEdition(id: string): Promise<EditionState> {
  if (configuredValue("EDITION_DIR")?.trim()) throw new Error("Edition selection is locked by OPERATOR_ENGINE_EDITION_DIR.")
  if (id !== "stock" && !(await loadEditions()).some((edition) => edition.id === id)) throw new Error(`Edition ${id} is not installed.`)
  const current = await editionSelection()
  const lastEditionId = id === "stock" ? current.lastEditionId : id
  await atomicJson(activeEditionPath(), { schemaVersion: 1, editionId: id, ...(lastEditionId ? { lastEditionId } : {}) }); return editionState()
}
const EDITION_ASSET_EXTENSIONS = new Set([".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".mp4", ".webm"])
const ASSET_MIME: Record<string, string> = { ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm" }

export async function editionAssetPayload(root: string, manifest: EditionManifestV1, relative: string, allowedExtensions: ReadonlySet<string>): Promise<{ bytes: Buffer; mime: string; etag: string } | null> {
  const extension = path.extname(relative).toLowerCase()
  if (!allowedExtensions.has(extension) || !declaredEditionAssets(manifest).includes(relative)) return null
  await validateAsset(root, relative)
  const bytes = await fs.readFile(path.resolve(root, relative))
  return { bytes, mime: ASSET_MIME[extension], etag: `"${createHash("sha256").update(bytes).digest("hex")}"` }
}

export async function activeAsset(relativeRequest: string): Promise<{ bytes: Buffer; mime: string; etag: string } | null> {
  const { edition } = await activeEditionInternal()
  if (!edition) return relativeRequest === "theme.css" ? { bytes: Buffer.from(""), mime: "text/css; charset=utf-8", etag: '"stock"' } : null
  const relative = relativeRequest === "theme.css" ? edition.stylesheet : relativeRequest
  return relative ? editionAssetPayload(edition.root, edition, relative, EDITION_ASSET_EXTENSIONS) : null
}
