import fs from "node:fs/promises"
import os from "node:os"
import { OMP_MANIFEST, parseOmpCandidate } from "@operator-studio/thread-ingest-adapter-omp"
import { scanProviderFiles, type LocalAdapterAccess } from "@operator-studio/thread-ingest-core"

import { getLane, updateLaneThreadLinks } from "@/lib/db"
import type { ThreadLink, ThreadMessage } from "@/lib/types"

export function createNodeAdapterAccess(customRoots?: string[]): LocalAdapterAccess {
  const env: Record<string, string | undefined> = { ...process.env }
  if (customRoots && customRoots.length > 0) {
    env.OPERATOR_STUDIO_OMP_ROOTS = customRoots.join(process.platform === "win32" ? ";" : ":")
  }
  return {
    platform: process.platform as "win32" | "darwin" | "linux",
    homeDirectory: os.homedir(),
    environment: env,
    filesystem: {
      async stat(pathStr: string) {
        try {
          const s = await fs.stat(pathStr)
          return {
            kind: s.isDirectory() ? "directory" : "file",
            modifiedAtMs: s.mtimeMs,
            createdAtMs: s.birthtimeMs,
            size: s.size,
          }
        } catch {
          return null
        }
      },
      async readDirectory(pathStr: string) {
        try {
          const entries = await fs.readdir(pathStr, { withFileTypes: true })
          return entries.map((e) => ({
            name: e.name,
            kind: e.isDirectory() ? ("directory" as const) : ("file" as const),
          }))
        } catch {
          return []
        }
      },
      async readFile(pathStr: string, options?: { maxBytes?: number }) {
        try {
          if (options?.maxBytes && options.maxBytes > 0) {
            const handle = await fs.open(pathStr, "r")
            try {
              const buffer = Buffer.alloc(options.maxBytes)
              const { bytesRead } = await handle.read(buffer, 0, options.maxBytes, 0)
              return buffer.toString("utf8", 0, bytesRead)
            } finally {
              await handle.close()
            }
          }
          return await fs.readFile(pathStr, "utf8")
        } catch {
          return ""
        }
      },
    },
  }
}

export type SafeOmpInventoryItem = {
  sourceSessionId: string
  title: string
  updatedAtMs: number | null
  messageCount: number
  alreadyImported: boolean
  providerId: "omp"
}

export async function getSafeOmpInventory(laneId?: string, customRoots?: string[]): Promise<SafeOmpInventoryItem[]> {
  const access = createNodeAdapterAccess(customRoots)
  const scanResult = await scanProviderFiles(OMP_MANIFEST, access)

  const importedSessionIds = new Set<string>()
  if (laneId) {
    const lane = getLane(laneId)
    if (lane?.threadLinks) {
      for (const link of lane.threadLinks) {
        importedSessionIds.add(link.sourceSessionId)
        if (link.id) importedSessionIds.add(link.id)
      }
    }
  }
  const items: SafeOmpInventoryItem[] = []

  const results = await Promise.all(
    scanResult.candidates.map(async (candidateFile) => {
      const content = await access.filesystem.readFile(candidateFile.path, { maxBytes: 64 * 1024 })
      if (!content) return null
      const parseResult = parseOmpCandidate({
        candidate: candidateFile,
        content,
        parserVersion: OMP_MANIFEST.parserVersion,
        isPartial: true,
        maxBytesRead: 64 * 1024,
      })
      if (parseResult.kind === "verified") {
        return {
          sourceSessionId: parseResult.sourceSessionId,
          title: parseResult.title ?? "OMP session",
          updatedAtMs: parseResult.updatedAtMs,
          messageCount: parseResult.messages.length,
          alreadyImported: importedSessionIds.has(parseResult.sourceSessionId),
          providerId: "omp" as const,
        }
      }
      return null
    })
  )

  for (const item of results) {
    if (item) items.push(item)
  }
  items.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
  return items
}

export async function ingestOmpSession(laneId: string, sourceSessionId: string, customRoots?: string[]) {
  const lane = getLane(laneId)
  if (!lane) {
    throw new Error("Lane not found")
  }

  const access = createNodeAdapterAccess(customRoots)
  const scanResult = await scanProviderFiles(OMP_MANIFEST, access)


  let targetParseResult: Extract<ReturnType<typeof parseOmpCandidate>, { kind: "verified" }> | null = null
  for (const candidateFile of scanResult.candidates) {
    const content = await access.filesystem.readFile(candidateFile.path)
    if (!content) continue
    const parseResult = parseOmpCandidate({ candidate: candidateFile, content, parserVersion: OMP_MANIFEST.parserVersion })
    if (parseResult.kind === "verified" && (
      parseResult.sourceSessionId === sourceSessionId ||
      parseResult.sourceSessionId === `omp-${sourceSessionId}` ||
      sourceSessionId === parseResult.sourceSessionId.replace(/^omp-/, "")
    )) {
      targetParseResult = parseResult
      break
    }
  }

  if (!targetParseResult) {
    throw new Error(`OMP session not found or invalid: ${sourceSessionId}`)
  }

  const now = new Date().toISOString()
  const messages: ThreadMessage[] = targetParseResult.messages.map((m) => ({
    role: m.role,
    content: m.content,
    timestampMs: m.timestampMs,
  }))

  const newLink: ThreadLink = {
    id: targetParseResult.sourceSessionId,
    sourceSessionId: targetParseResult.sourceSessionId,
    provider: "omp",
    title: targetParseResult.title ?? "OMP session",
    updatedAt: targetParseResult.updatedAtMs ? new Date(targetParseResult.updatedAtMs).toISOString() : now,
    importedAt: now,
    messageCount: targetParseResult.messages.length,
    messages,
  }

  const currentLinks = lane.threadLinks ?? []
  const existingIndex = currentLinks.findIndex((link) => link.sourceSessionId === newLink.sourceSessionId || link.id === newLink.id)
  let updatedLinks: ThreadLink[]
  if (existingIndex >= 0) {
    updatedLinks = [...currentLinks]
    updatedLinks[existingIndex] = newLink
  } else {
    updatedLinks = [newLink, ...currentLinks]
  }

  const updatedLane = updateLaneThreadLinks(laneId, updatedLinks)
  return { lane: updatedLane, threadLink: newLink }
}
