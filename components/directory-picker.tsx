"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronRight, File, Folder, FolderPlus, X } from "lucide-react"

import { useDistribution } from "@/components/distribution-provider"
import { Button } from "@/components/ui/button"
import { canStartNewHarness, firstAvailableNewHarness, orderHarnesses } from "@/lib/harness-policy"
import { readJsonResponse } from "@/lib/http-client"
import type { DirectoryEntry, HarnessId, Lane } from "@/lib/types"

type WorkspaceRootOption = { id: string; name: string; path: string }
type DirectoryState = {
  roots: WorkspaceRootOption[]
  activeRoot: WorkspaceRootOption
  currentPath: string
  entries: DirectoryEntry[]
  isEmpty: boolean
  hasGit: boolean
}

function rootLabel(root: WorkspaceRootOption): string {
  const parts = root.path.split(/[\\/]/).filter(Boolean)
  const separator = root.path.includes("\\") ? "\\" : "/"
  return parts.length > 3 ? `…${separator}${parts.slice(-3).join(separator)}` : root.path
}


export function DirectoryPicker({ onClose, onCreated, starterId }: { onClose: () => void; onCreated: (lane: Lane, starterResult?: { entry: string }) => void; starterId?: "browser-showpiece" }) {
  const edition = useDistribution()
  const [state, setState] = useState<DirectoryState | null>(null)
  const harnesses = useMemo(() => orderHarnesses(edition.harnesses, edition.distributionId), [edition.distributionId, edition.harnesses])
  const [folderName, setFolderName] = useState("")
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [harnessId, setHarnessId] = useState<HarnessId>(() => firstAvailableNewHarness(harnesses, edition.distributionId))
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (relativePath = "", rootId?: string) => {
    try {
      setError("")
      const root = rootId ? `&root=${encodeURIComponent(rootId)}` : ""
      const response = await fetch(`/api/directories?path=${encodeURIComponent(relativePath)}${root}`)
      const next = await readJsonResponse<DirectoryState>(response, `Request failed (${response.status}).`)
      setState(next)
      setNewFolderOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to browse folders.")
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!harnesses.some((item) => item.id === harnessId && item.state === "available" && canStartNewHarness(item.id, edition.distributionId))) setHarnessId(firstAvailableNewHarness(harnesses, edition.distributionId))
  }, [edition.distributionId, harnessId, harnesses])

  const selectedHarness = harnesses.find((item) => item.id === harnessId)
  const fullPath = state ? `${state.activeRoot.path}${state.currentPath ? `/${state.currentPath}` : ""}` : "Loading…"
  const agentLabel = selectedHarness?.label ?? "Your agent"

  const goUp = () => {
    const parts = (state?.currentPath ?? "").split("/").filter(Boolean)
    parts.pop()
    void load(parts.join("/"), state?.activeRoot.id)
  }

  const makeFolder = async () => {
    try {
      const response = await fetch("/api/directories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: state?.currentPath ?? "", name: folderName, rootId: state?.activeRoot.id }),
      })
      const result = await readJsonResponse<{ relativePath: string }>(response, `Request failed (${response.status}).`)
      setFolderName("")
      await load(result.relativePath, state?.activeRoot.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create folder.")
    }
  }

  const create = async () => {
    try {
      setCreating(true)
      setError("")
      const response = await fetch("/api/lanes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rootId: state?.activeRoot.id,
          path: state?.currentPath ?? "",
          recipeId: "existing-folder",
          defaultHarness: harnessId,
          initializeGit: !state?.hasGit,
          existingFolderUnchanged: true,
          ...(starterId ? { distributionId: edition.distributionId, starterId } : {}),
        }),
      })
      const result = await readJsonResponse<{ lane: Lane; starter?: { entry: string } }>(response, `Request failed (${response.status}).`)
      onCreated(result.lane, result.starter)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to add ${edition.workItemSingular}.`)
      setCreating(false)
    }
  }

  const canCreate = useMemo(() => Boolean(
    state
    && selectedHarness
    && canStartNewHarness(selectedHarness.id, edition.distributionId)
    && selectedHarness.state === "available",
  ), [edition.distributionId, selectedHarness, state])

  return <div className="fixed inset-0 z-[200] grid place-items-center bg-black/50 p-4 backdrop-blur-[1px]" role="presentation" onMouseDown={onClose}>
    <section className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="new-lane-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="flex shrink-0 items-start gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="new-lane-title" className="text-lg font-semibold">Choose the folder for this {edition.workItemSingular}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{agentLabel} can work with everything inside it. Git will be initialized if needed.</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>
      </header>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">
        {state && state.roots.length > 1 ? <label className="grid min-w-0 gap-1 text-[10px] font-medium text-muted-foreground">
          Project root
          <select aria-label="Project root" value={state.activeRoot.id} onChange={(event) => void load("", event.target.value)} className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground">
            {state.roots.map((root) => <option key={root.id} value={root.id}>{rootLabel(root)}</option>)}
          </select>
        </label> : null}

        <div className={`${state && state.roots.length > 1 ? "mt-5 " : ""}overflow-hidden rounded-md border border-border`} aria-label="Project folder browser">
          <div className="flex items-start gap-3 border-b border-border px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Project folder</p>
              <code className="mt-1 block truncate text-xs text-foreground" title={fullPath}>{fullPath}</code>
            </div>
            {!newFolderOpen ? <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setNewFolderOpen(true)}><FolderPlus className="size-4" /> New folder</Button> : null}
          </div>

          <div className="max-h-60 min-h-32 overflow-y-auto px-2 py-1.5">
            {newFolderOpen ? <div className="flex gap-2 border-b border-border px-1 py-2">
              <input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && folderName.trim()) void makeFolder(); if (event.key === "Escape") setNewFolderOpen(false) }} placeholder="Folder name" className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm" />
              <Button size="sm" onClick={() => void makeFolder()} disabled={!folderName.trim()}>Create</Button>
              <Button variant="ghost" size="sm" onClick={() => { setFolderName(""); setNewFolderOpen(false) }}>Cancel</Button>
            </div> : null}
            {!state ? <p className="px-1 py-5 text-sm text-muted-foreground">Loading…</p> : <>
              {state.currentPath ? <button type="button" aria-label="Up one folder" onClick={goUp} className="flex w-full items-center gap-2 px-1 py-2 text-left text-sm text-muted-foreground hover:text-foreground"><Folder className="size-4" /><span className="font-mono">..</span></button> : null}
              {state.entries.length ? state.entries.map((entry) => entry.kind === "directory" ? <button key={entry.relativePath} onClick={() => void load(entry.relativePath, state.activeRoot.id)} className="flex w-full items-center gap-2 rounded px-1 py-2 text-left text-sm hover:bg-muted hover:text-primary"><Folder className="size-4 text-muted-foreground" />{entry.name}<ChevronRight className="ml-auto size-3.5 text-muted-foreground" /></button> : <div key={entry.relativePath} className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground"><File className="size-4" />{entry.name}</div>) : <p className="px-1 py-5 text-sm text-muted-foreground">This folder is empty.</p>}
            </>}
          </div>
        </div>

        {error ? <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      </div>

      <footer className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button data-distribution-onboarding-target="directory-picker" onClick={() => void create()} disabled={!canCreate || creating}>{creating ? `Adding ${edition.workItemSingular}…` : `Add ${edition.workItemSingular}`}</Button>
      </footer>
    </section>
  </div>
}
