"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Eye, FileCode2, FolderGit2, Info, RefreshCw, X } from "lucide-react"

import { FileTree } from "@/components/file-tree"
import { Button } from "@/components/ui/button"
import { readJsonResponse } from "@/lib/http-client"
import type { FileNode } from "@/lib/types"

type GitState = { available: boolean; branch: string | null; lines: string[] }


export function FilesPane({ laneId, paneId, onOpenWebPreview }: { laneId: string; paneId: string; onOpenWebPreview: (entryPath: string, sourcePaneId: string) => void }) {
  const [tree, setTree] = useState<FileNode[]>([])
  const [git, setGit] = useState<GitState>({ available: false, branch: null, lines: [] })
  const [preview, setPreview] = useState<{ path: string; content: string; truncated: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const paneRef = useRef<HTMLDivElement>(null)
  const workingTreeRef = useRef<HTMLDivElement>(null)
  const [workingTreeHeight, setWorkingTreeHeight] = useState<number | null>(null)
  const [resizingWorkingTree, setResizingWorkingTree] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/lanes/${laneId}/tree`)
      const result = await readJsonResponse<{ tree: FileNode[]; git: GitState }>(response, `Request failed (${response.status}).`)
      setTree(result.tree)
      setGit(result.git)
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to refresh files.")
    } finally {
      setLoading(false)
    }
  }, [laneId])

  useEffect(() => {
    setLoading(true)
    setPreview(null)
    void refresh()
    const timer = setInterval(() => void refresh(), 3_000)
    return () => clearInterval(timer)
  }, [refresh])

  const openFile = async (relativePath: string) => {
    try {
      const response = await fetch(`/api/lanes/${laneId}/file?path=${encodeURIComponent(relativePath)}`)
      const result = await readJsonResponse<{ content: string; truncated: boolean }>(response, `Request failed (${response.status}).`)
      setPreview({ path: relativePath, ...result })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to preview file.")
    }
  }

  const clampWorkingTreeHeight = (height: number) => {
    const paneHeight = paneRef.current?.getBoundingClientRect().height ?? 0
    return Math.min(Math.max(48, paneHeight - 96), Math.max(48, height))
  }

  const resizeWorkingTree = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const panel = workingTreeRef.current
    if (!panel) return
    const pointerId = event.pointerId
    const startY = event.clientY
    const startHeight = panel.getBoundingClientRect().height
    handle.setPointerCapture(pointerId)
    setResizingWorkingTree(true)
    const move = (next: PointerEvent) => {
      setWorkingTreeHeight(clampWorkingTreeHeight(startHeight + startY - next.clientY))
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", stop)
      if (handle.isConnected && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      setResizingWorkingTree(false)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("blur", stop)
  }

  const resizeWorkingTreeFromKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const height = workingTreeRef.current?.getBoundingClientRect().height
    if (height === undefined) return
    let nextHeight: number
    if (event.key === "ArrowUp") nextHeight = height + 16
    else if (event.key === "ArrowDown") nextHeight = height - 16
    else if (event.key === "Home") nextHeight = 48
    else if (event.key === "End") nextHeight = Number.POSITIVE_INFINITY
    else return
    event.preventDefault()
    setWorkingTreeHeight(clampWorkingTreeHeight(nextHeight))
  }

  return (
    <div ref={paneRef} className="flex h-full min-h-0 flex-col bg-hud-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2 text-[11px]">
        {git.available ? <FolderGit2 className="size-3.5 text-muted-foreground" /> : <FileCode2 className="size-3.5 text-muted-foreground" />}
        <strong className="truncate font-medium">{git.available ? git.branch ?? "Git" : "Plain directory"}</strong>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {git.available ? (git.lines.length ? `${git.lines.length} changed` : "clean") : "Git not initialized"}
        </span>
        <Button variant="ghost" size="icon-sm" className="size-7" onClick={() => void refresh()} aria-label="Refresh files">
          <RefreshCw className="size-3" />
        </Button>
      </div>
      {!git.available && !loading ? (
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 text-[10px] text-muted-foreground">
          <Info className="size-3 shrink-0" /> Files work normally. Git status appears after this directory is initialized as a repository.
        </div>
      ) : null}
      {error ? <div className="border-b border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[10px] text-destructive">{error}</div> : null}
      {loading ? (
        <div className="grid flex-1 place-items-center text-xs text-muted-foreground">Loading files…</div>
      ) : tree.length ? (
        <div className="min-h-0 flex-1 overflow-auto px-1 py-1.5 border-b border-border/50">
          <FileTree nodes={tree} onFile={openFile} />
        </div>
      ) : (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div><div className="text-xl text-muted-foreground/60">∅</div><p className="mt-2 text-xs text-muted-foreground">This directory is empty.</p><p className="mt-1 text-[10px] text-muted-foreground/70">Open a terminal when you are ready to shape it.</p></div>
        </div>
      )}
      {preview ? (
        <div className="flex h-1/2 min-h-[160px] shrink-0 flex-col border-t border-border bg-stone-950">
          <div className="flex h-8 shrink-0 items-center border-b border-border bg-stone-900 px-2">
            <code className="min-w-0 flex-1 truncate text-[10px] text-sky-400 font-mono">{preview.path}</code>
            {preview.path.toLowerCase().endsWith(".html") ? (
              <Button variant="outline" size="sm" className="mr-1 h-6 px-2 text-[9px]" onClick={() => onOpenWebPreview(preview.path, paneId)}>
                <Eye className="size-3" /> Open in Browser
              </Button>
            ) : null}
            <Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setPreview(null)} aria-label="Close file preview">
              <X className="size-3" />
            </Button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 text-[10px] font-mono leading-relaxed text-stone-200">
            {preview.content}{preview.truncated ? "\n\n… preview truncated" : ""}
          </pre>
        </div>
      ) : null}
      {git.lines.length > 0 && !preview ? (
        <>
          <button
            type="button"
            data-working-tree-resizer
            aria-label="Resize working tree"
            title="Drag to resize the working tree"
            onPointerDown={resizeWorkingTree}
            onKeyDown={resizeWorkingTreeFromKeyboard}
            className="z-30 h-1 w-full shrink-0 touch-none cursor-row-resize bg-border hover:bg-muted-foreground focus-visible:bg-muted-foreground focus-visible:outline-none"
          />
          <div
            ref={workingTreeRef}
            data-working-tree-panel
            className="min-h-0 shrink-0 overflow-auto p-2"
            style={workingTreeHeight === null ? { maxHeight: "9rem" } : { height: workingTreeHeight }}
          >
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Working tree</div>
            {git.lines.slice(0, 30).map((line) => <code className="block truncate py-0.5 text-[10px] text-muted-foreground" key={line}>{line}</code>)}
          </div>
          {resizingWorkingTree ? <div aria-hidden="true" className="fixed inset-0 z-[100] touch-none select-none cursor-row-resize" /> : null}
        </>
      ) : null}
    </div>
  )
}
