import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"

import { workspaceRoots } from "@/lib/config"
import { isPathInside, relativePortablePath } from "@/lib/path-containment"
import type { DirectoryEntry } from "@/lib/types"

const SIMPLE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]+$/


export type ConfiguredWorkspaceRoot = { id: string; name: string; path: string }

function rootId(root: string): string {
  const stable = process.platform === "win32" ? root.toLowerCase() : root
  return `root-${createHash("sha256").update(stable).digest("base64url").slice(0, 12)}`
}

export async function canonicalWorkspaceRoots(): Promise<ConfiguredWorkspaceRoot[]> {
  const roots: ConfiguredWorkspaceRoot[] = []
  for (const configured of workspaceRoots()) {
    await fs.mkdir(configured, { recursive: true })
    const canonical = await fs.realpath(configured)
    if (roots.some((root) => root.path === canonical)) continue
    roots.push({ id: rootId(canonical), name: path.basename(canonical) || canonical, path: canonical })
  }
  return roots
}

export async function canonicalWorkspaceRoot(): Promise<string> {
  const [root] = await canonicalWorkspaceRoots()
  if (!root) throw new Error("No workspace root is configured.")
  return root.path
}

async function selectedWorkspaceRoot(id?: string): Promise<ConfiguredWorkspaceRoot> {
  const roots = await canonicalWorkspaceRoots()
  const selected = id ? roots.find((root) => root.id === id) : roots[0]
  if (!selected) throw new Error("Configured workspace root not found.")
  return selected
}

export async function resolveWorkspaceDirectory(input = "", rootId?: string): Promise<string> {
  const root = await selectedWorkspaceRoot(rootId)
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root.path, input)
  if (!isPathInside(root.path, candidate)) throw new Error("Directory must be inside a configured workspace root.")
  const canonical = await fs.realpath(candidate)
  if (!isPathInside(root.path, canonical)) throw new Error("Directory symlink escapes its configured workspace root.")
  const stat = await fs.stat(canonical)
  if (!stat.isDirectory()) throw new Error("Selected path is not a directory.")
  return canonical
}

export async function relativeWorkspacePath(directory: string): Promise<string> {
  const root = (await canonicalWorkspaceRoots()).find((candidate) => isPathInside(candidate.path, directory))
  if (!root) throw new Error("Directory must be inside a configured workspace root.")
  return relativePortablePath(root.path, directory)
}

export async function listDirectories(relativePath = "", rootId?: string): Promise<{
  roots: ConfiguredWorkspaceRoot[]
  activeRoot: ConfiguredWorkspaceRoot
  currentPath: string
  entries: DirectoryEntry[]
  isEmpty: boolean
  hasGit: boolean
}> {
  const roots = await canonicalWorkspaceRoots()
  const activeRoot = rootId ? roots.find((root) => root.id === rootId) : roots[0]
  if (!activeRoot) throw new Error("Configured workspace root not found.")
  const current = await resolveWorkspaceDirectory(relativePath, activeRoot.id)
  const entries = await fs.readdir(current, { withFileTypes: true })
  const visibleEntries = entries
    .filter((entry) => (entry.isDirectory() && entry.name !== ".git") || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      relativePath: path.relative(activeRoot.path, path.join(current, entry.name)).split(path.sep).join("/"),
      kind: entry.isDirectory() ? "directory" as const : "file" as const,
    }))
    .sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1)
  return {
    roots,
    activeRoot,
    currentPath: path.relative(activeRoot.path, current).split(path.sep).join("/"),
    entries: visibleEntries,
    isEmpty: entries.length === 0,
    hasGit: entries.some((entry) => entry.name === ".git"),
  }
}

export async function makeWorkspaceDirectory(parent: string, name: string, rootId?: string): Promise<string> {
  const cleanName = name.trim()
  if (!cleanName || cleanName === "." || cleanName === ".." || !SIMPLE_NAME.test(cleanName)) {
    throw new Error("Folder name contains unsupported characters.")
  }
  const root = await selectedWorkspaceRoot(rootId)
  const canonicalParent = await resolveWorkspaceDirectory(parent, root.id)
  const candidate = path.join(canonicalParent, cleanName)
  if (!isPathInside(root.path, candidate)) throw new Error("Folder must be inside its configured workspace root.")
  await fs.mkdir(candidate)
  return path.relative(root.path, candidate).split(path.sep).join("/")
}

export async function resolveLaneFile(laneRoot: string, relativePath: string): Promise<string> {
  const canonicalLane = await fs.realpath(laneRoot)
  const candidate = path.resolve(canonicalLane, relativePath)
  if (!isPathInside(canonicalLane, candidate)) throw new Error("File must be inside the lane directory.")
  const canonical = await fs.realpath(candidate)
  if (!isPathInside(canonicalLane, canonical)) throw new Error("File symlink escapes the lane directory.")
  return canonical
}

export const workspacePathInternals = { isInside: isPathInside }
