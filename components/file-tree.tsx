"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen } from "lucide-react"
import type { FileNode } from "@/lib/types"

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase()
  if (["ts", "tsx", "js", "jsx", "json", "html", "css", "py", "rs", "go", "mjs"].includes(ext || "")) {
    return <FileCode2 className="size-3.5 shrink-0 text-sky-400" />
  }
  return <FileText className="size-3.5 shrink-0 text-muted-foreground" />
}

export function FileTree({
  nodes,
  onFile,
  depth = 0,
}: {
  nodes: FileNode[]
  onFile: (path: string) => void
  depth?: number
}) {
  return (
    <div className="select-none font-mono text-xs">
      {nodes.map((node) => (
        <FileTreeNode key={node.relativePath} node={node} onFile={onFile} depth={depth} />
      ))}
    </div>
  )
}

function FileTreeNode({
  node,
  onFile,
  depth,
}: {
  node: FileNode
  onFile: (path: string) => void
  depth: number
}) {
  const [open, setOpen] = useState(depth < 1)

  if (node.kind === "directory") {
    return (
      <div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen(!open) }}
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-stone-300 hover:bg-stone-800/60 hover:text-stone-100"
        >
          {open ? (
            <>
              <ChevronDown className="size-3 shrink-0 text-stone-500" />
              <FolderOpen className="size-3.5 shrink-0 text-amber-400" />
            </>
          ) : (
            <>
              <ChevronRight className="size-3 shrink-0 text-stone-500" />
              <Folder className="size-3.5 shrink-0 text-amber-400/80" />
            </>
          )}
          <span className="truncate text-[11px] font-medium">{node.name}</span>
        </div>
        {open && node.children && node.children.length > 0 ? (
          <div>
            <FileTree nodes={node.children} onFile={onFile} depth={depth + 1} />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onFile(node.relativePath)}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
      className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-left text-stone-400 hover:bg-stone-800/80 hover:text-stone-100 focus-visible:bg-stone-800 focus-visible:outline-none"
    >
      {getFileIcon(node.name)}
      <span className="truncate text-[11px]">{node.name}</span>
    </button>
  )
}
