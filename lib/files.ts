import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

import type { FileNode } from "@/lib/types"
import { resolveLaneFile } from "@/lib/workspace"

const OMIT = new Set([".git", ".next", "node_modules"])
const MAX_NODES = 800
const MAX_DEPTH = 8
const MAX_PREVIEW_BYTES = 512 * 1024

export async function readFileTree(root: string): Promise<FileNode[]> {
  let seen = 0
  async function walk(directory: string, depth: number): Promise<FileNode[]> {
    if (depth > MAX_DEPTH || seen >= MAX_NODES) return []
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const nodes: FileNode[] = []
    for (const entry of entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })) {
      if (seen >= MAX_NODES || OMIT.has(entry.name) || entry.isSymbolicLink()) continue
      seen += 1
      const absolute = path.join(directory, entry.name)
      const relativePath = path.relative(root, absolute).split(path.sep).join("/")
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          relativePath,
          kind: "directory",
          children: await walk(absolute, depth + 1),
        })
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, relativePath, kind: "file" })
      }
    }
    return nodes
  }
  return walk(root, 0)
}

export async function readTextPreview(
  laneRoot: string,
  relativePath: string
): Promise<{ content: string; truncated: boolean }> {
  const file = await resolveLaneFile(laneRoot, relativePath)
  const stat = await fs.stat(file)
  if (!stat.isFile()) throw new Error("Selected path is not a file.")
  const handle = await fs.open(file, "r")
  try {
    const length = Math.min(stat.size, MAX_PREVIEW_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    if (buffer.includes(0)) throw new Error("Binary files are not previewed.")
    return { content: buffer.toString("utf8"), truncated: stat.size > length }
  } finally {
    await handle.close()
  }
}

export async function gitStatus(cwd: string): Promise<{
  available: boolean
  branch: string | null
  lines: string[]
}> {
  return new Promise((resolve) => {
    const child = spawn("git", ["status", "--short", "--branch", "--untracked-files=normal"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.once("error", () => resolve({ available: false, branch: null, lines: [] }))
    child.once("exit", (code) => {
      if (code !== 0) return resolve({ available: false, branch: null, lines: [] })
      const lines = stdout.split(/\r?\n/).filter(Boolean)
      const header = lines[0]?.startsWith("## ") ? lines.shift()! : null
      resolve({
        available: true,
        branch: header ? header.slice(3).split("...")[0] : null,
        lines,
      })
    })
  })
}
