import { isValidClientIdentityPart, updatePaneInTree } from "../scripts/layout-tree-policy.mjs"
import type { SavedLayoutV1, TerminalPaneConfig, WebPreviewPaneConfigV1 } from "@/lib/types"

export const STOCK_PANE_KINDS = ["terminal", "files", "web-preview"] as const
export const PERSISTED_PANE_KINDS = [...STOCK_PANE_KINDS, "t4-code"] as const
export type PaneKind = (typeof PERSISTED_PANE_KINDS)[number]

function isPaneKind(value: unknown): value is PaneKind {
  return value === "terminal" || value === "files" || value === "web-preview" || value === "t4-code"
}

export type PaneNode = {
  kind: "pane"
  id: string
  pane: PaneKind
  config?: unknown
}
export type SplitNode = {
  kind: "split"
  direction: "horizontal" | "vertical"
  first: LayoutNode
  second: LayoutNode
  percentage: number
}
export type TabsNode = { kind: "tabs"; panes: PaneNode[]; activeId: string }
export type LayoutNode = PaneNode | SplitNode | TabsNode
export type DropZone = "left" | "right" | "top" | "bottom" | "center"

export function terminalPane(
  id: string,
  role: TerminalPaneConfig["role"] = "additional",
): PaneNode {
  return { kind: "pane", id, pane: "terminal", config: { role } }
}

export function webPreviewPane(id: string, location: string | null = null, revision = 0): PaneNode {
  return { kind: "pane", id, pane: "web-preview", config: { location, revision } }
}

export function terminalPaneConfig(pane: PaneNode): TerminalPaneConfig | null {
  if (pane.pane !== "terminal") return null
  const config = pane.config && typeof pane.config === "object" ? pane.config : null
  return { role: config && "role" in config && config.role === "first" ? "first" : "additional" }
}

export function webPreviewPaneConfig(pane: PaneNode): WebPreviewPaneConfigV1 {
  if (pane.pane !== "web-preview" || !pane.config || typeof pane.config !== "object") {
    return { location: null, revision: 0 }
  }
  const config = pane.config
  const location = "location" in config ? config.location : undefined
  const entryPath = "entryPath" in config ? config.entryPath : undefined
  const revision = "revision" in config ? config.revision : undefined
  return {
    location: typeof location === "string" ? location : typeof entryPath === "string" ? entryPath : null,
    revision: Number.isSafeInteger(revision) && Number(revision) >= 0 ? Number(revision) : 0,
  }
}

export function defaultLayout(panes: string[] = ["terminal", "files"]): LayoutNode {
  const supported = panes.filter(isPaneKind)
  const requested: PaneKind[] = supported.length ? supported : panes.length ? ["terminal", "files"] : ["terminal"]
  let terminals = 0
  let files = 0
  let webPreviews = 0
  let t4Codes = 0
  const created = requested.map((pane): PaneNode => {
    if (pane === "terminal") {
      const index = terminals++
      return terminalPane(index === 0 ? "terminal-main" : `terminal-${index}`, index === 0 ? "first" : "additional")
    }
    if (pane === "web-preview") {
      const index = webPreviews++
      return webPreviewPane(index === 0 ? "web-preview-main" : `web-preview-${index}`)
    }
    if (pane === "t4-code") {
      const index = t4Codes++
      return { kind: "pane", id: index === 0 ? "t4-code-main" : `t4-code-${index}`, pane: "t4-code" }
    }
    const index = files++
    return { kind: "pane", id: index === 0 ? "files-main" : `files-${index}`, pane: "files" }
  })
  if (created.length === 1) return created[0]
  let second: LayoutNode = created[1]
  for (const pane of created.slice(2)) {
    second = { kind: "split", direction: "vertical", percentage: 50, first: second, second: pane }
  }
  return {
    kind: "split",
    direction: "horizontal",
    percentage: 74,
    first: created[0],
    second,
  }
}

export function paneIds(node: LayoutNode): string[] {
  if (node.kind === "pane") return [node.id]
  if (node.kind === "tabs") return node.panes.map((pane) => pane.id)
  return [...paneIds(node.first), ...paneIds(node.second)]
}

export function updateSplit(node: LayoutNode, target: SplitNode, percentage: number): LayoutNode {
  if (node === target) return { ...target, percentage: Math.min(85, Math.max(15, percentage)) }
  if (node.kind !== "split") return node
  return { ...node, first: updateSplit(node.first, target, percentage), second: updateSplit(node.second, target, percentage) }
}

export function replacePane(node: LayoutNode, paneId: string, replacement: LayoutNode): LayoutNode {
  if (node.kind === "pane") return node.id === paneId ? replacement : node
  if (node.kind === "tabs") {
    const index = node.panes.findIndex((pane) => pane.id === paneId)
    if (index < 0) return node
    if (replacement.kind !== "pane") return replacement
    const panes = [...node.panes]
    panes[index] = replacement
    return { ...node, panes, activeId: replacement.id }
  }
  return { ...node, first: replacePane(node.first, paneId, replacement), second: replacePane(node.second, paneId, replacement) }
}

export function updatePane(node: LayoutNode, paneId: string, update: (pane: PaneNode) => PaneNode): LayoutNode {
  return updatePaneInTree(node, paneId, (pane) => update(pane as PaneNode)) as LayoutNode
}

export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node
  if (node.kind === "tabs") {
    const panes = node.panes.filter((pane) => pane.id !== paneId)
    if (panes.length === node.panes.length) return node
    if (!panes.length) return null
    if (panes.length === 1) return panes[0]
    return { ...node, panes, activeId: panes.some((pane) => pane.id === node.activeId) ? node.activeId : panes[0].id }
  }
  const first = removePane(node.first, paneId)
  const second = removePane(node.second, paneId)
  if (!first) return second
  if (!second) return first
  return { ...node, first, second }
}

export function insertPane(node: LayoutNode, targetId: string, pane: PaneNode, zone: DropZone): LayoutNode {
  if (node.kind === "split") {
    if (findPane(node.first, targetId)) return { ...node, first: insertPane(node.first, targetId, pane, zone) }
    if (findPane(node.second, targetId)) return { ...node, second: insertPane(node.second, targetId, pane, zone) }
    return node
  }
  if (node.kind === "tabs") {
    const target = node.panes.find((candidate) => candidate.id === targetId)
    if (!target) return node
    if (zone === "center") return { ...node, panes: [...node.panes, pane], activeId: pane.id }
    const horizontal = zone === "left" || zone === "right"
    const before = zone === "left" || zone === "top"
    return {
      kind: "split",
      direction: horizontal ? "horizontal" : "vertical",
      percentage: 50,
      first: before ? pane : node,
      second: before ? node : pane,
    }
  }
  if (node.id !== targetId) return node
  if (zone === "center") {
    return { kind: "tabs", panes: [node, pane], activeId: pane.id }
  }
  const horizontal = zone === "left" || zone === "right"
  const before = zone === "left" || zone === "top"
  return {
    kind: "split",
    direction: horizontal ? "horizontal" : "vertical",
    percentage: 50,
    first: before ? pane : node,
    second: before ? node : pane,
  }
}

export function movePane(node: LayoutNode, sourceId: string, targetId: string, zone: DropZone): LayoutNode {
  if (sourceId === targetId) return node
  const source = findPane(node, sourceId)
  if (!source || !findPane(node, targetId)) return node
  const without = removePane(node, sourceId)
  if (!without || !findPane(without, targetId)) return node
  return insertPane(without, targetId, source, zone)
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.kind === "pane") return node.id === paneId ? node : null
  if (node.kind === "tabs") return node.panes.find((pane) => pane.id === paneId) ?? null
  return findPane(node.first, paneId) ?? findPane(node.second, paneId)
}

export function findFirstPaneByType(node: LayoutNode, paneType: string): PaneNode | null {
  if (node.kind === "pane") return node.pane === paneType ? node : null
  if (node.kind === "tabs") return node.panes.find((pane) => pane.pane === paneType) ?? null
  return findFirstPaneByType(node.first, paneType) ?? findFirstPaneByType(node.second, paneType)
}

export function openWebPreview(
  node: LayoutNode,
  input: { location: string; sourcePaneId: string; newPaneId: string }
): LayoutNode {
  const existing = findFirstPaneByType(node, "web-preview")
  if (existing) {
    return updatePane(node, existing.id, (pane) => {
      const config = webPreviewPaneConfig(pane)
      return { ...pane, config: { location: input.location, revision: config.revision + 1 } }
    })
  }
  const target = findPane(node, input.sourcePaneId) ?? findPane(node, paneIds(node)[0] ?? "")
  if (!target) return node
  return insertPane(node, target.id, webPreviewPane(input.newPaneId, input.location, 1), "right")
}

export function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== "object") return false
  const node = value as Record<string, unknown>
  if (node.kind === "pane") return isPaneKind(node.pane) && isValidClientIdentityPart(node.id)
  if (node.kind === "tabs") {
    return Array.isArray(node.panes) && node.panes.length > 0 && node.panes.every((pane) => isLayoutNode(pane) && pane.kind === "pane") && typeof node.activeId === "string"
  }
  return node.kind === "split" &&
    (node.direction === "horizontal" || node.direction === "vertical") &&
    typeof node.percentage === "number" &&
    isLayoutNode(node.first) && isLayoutNode(node.second)
}

type PrunedLayout = { valid: true; node: LayoutNode | null } | { valid: false }

function prunePersistedLayout(value: unknown, paneIds: Set<string> = new Set()): PrunedLayout {
  if (!value || typeof value !== "object") return { valid: false }
  const candidate = value as Record<string, unknown>
  if (candidate.kind === "pane") {
    if (!isValidClientIdentityPart(candidate.id) || paneIds.has(candidate.id) || typeof candidate.pane !== "string" || candidate.pane.length === 0) {
      return { valid: false }
    }
    paneIds.add(candidate.id)
    if (!isPaneKind(candidate.pane)) return { valid: true, node: null }
    return {
      valid: true,
      node: {
        kind: "pane",
        id: candidate.id,
        pane: candidate.pane,
        ...("config" in candidate ? { config: candidate.config } : {}),
      },
    }
  }
  if (candidate.kind === "tabs") {
    if (!Array.isArray(candidate.panes) || typeof candidate.activeId !== "string") return { valid: false }
    const panes: PaneNode[] = []
    for (const value of candidate.panes) {
      const pruned = prunePersistedLayout(value, paneIds)
      if (!pruned.valid || (pruned.node && pruned.node.kind !== "pane")) return { valid: false }
      if (pruned.node) panes.push(pruned.node)
    }
    if (!panes.length) return { valid: true, node: null }
    if (panes.length === 1) return { valid: true, node: panes[0] }
    return {
      valid: true,
      node: {
        kind: "tabs",
        panes,
        activeId: panes.some((pane) => pane.id === candidate.activeId) ? candidate.activeId : panes[0].id,
      },
    }
  }
  if (candidate.kind !== "split" ||
      (candidate.direction !== "horizontal" && candidate.direction !== "vertical") ||
      typeof candidate.percentage !== "number") {
    return { valid: false }
  }
  const first = prunePersistedLayout(candidate.first, paneIds)
  const second = prunePersistedLayout(candidate.second, paneIds)
  if (!first.valid || !second.valid) return { valid: false }
  if (!first.node) return { valid: true, node: second.node }
  if (!second.node) return { valid: true, node: first.node }
  return {
    valid: true,
    node: {
      kind: "split",
      direction: candidate.direction,
      percentage: candidate.percentage,
      first: first.node,
      second: second.node,
    },
  }
}

function migrateTerminalConfig(node: LayoutNode): LayoutNode {
  if (node.kind === "pane") {
    if (node.pane === "web-preview") {
      const config = webPreviewPaneConfig(node)
      const location = typeof config.location === "string" && config.location.length <= 2_048 ? config.location : null
      const revision = Number.isSafeInteger(config.revision) && config.revision >= 0 ? config.revision : 0
      return { ...node, config: { location, revision } }
    }
    if (node.pane !== "terminal") return node
    return { ...node, config: terminalPaneConfig(node) }
  }
  if (node.kind === "tabs") {
    const panes: PaneNode[] = []
    for (const pane of node.panes) {
      const migrated = migrateTerminalConfig(pane)
      if (migrated.kind === "pane") panes.push(migrated)
    }
    return { ...node, panes }
  }
  return { ...node, first: migrateTerminalConfig(node.first), second: migrateTerminalConfig(node.second) }
}

export function keepSingleWebPreview(node: LayoutNode): LayoutNode {
  let found = false
  const visit = (candidate: LayoutNode): LayoutNode | null => {
    if (candidate.kind === "pane") {
      if (candidate.pane !== "web-preview") return candidate
      if (found) return null
      found = true
      return candidate
    }
    if (candidate.kind === "tabs") {
      const panes: PaneNode[] = []
      for (const pane of candidate.panes) {
        const kept = visit(pane)
        if (kept?.kind === "pane") panes.push(kept)
      }
      if (!panes.length) return null
      if (panes.length === 1) return panes[0]
      return { ...candidate, panes, activeId: panes.some((pane) => pane.id === candidate.activeId) ? candidate.activeId : panes[0].id }
    }
    const first = visit(candidate.first)
    const second = visit(candidate.second)
    if (!first) return second
    if (!second) return first
    return { ...candidate, first, second }
  }
  return visit(node) ?? node
}

export function parseSavedLayout(value: unknown): SavedLayoutV1 | null {
  let source = value
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 1) {
    source = "tree" in value ? value.tree : undefined
  }
  const pruned = prunePersistedLayout(source)
  if (!pruned.valid) return null
  if (!pruned.node) return { schemaVersion: 1, tree: defaultLayout() }
  return {
    schemaVersion: 1,
    tree: keepSingleWebPreview(migrateTerminalConfig(pruned.node)),
  }
}
