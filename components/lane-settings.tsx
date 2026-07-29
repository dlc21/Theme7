"use client"

import { useEffect, useState } from "react"
import { X } from "lucide-react"

import { OmpIngestPanel } from "@/components/omp-ingest-panel"

import { useDistribution } from "@/components/distribution-provider"
import { Button } from "@/components/ui/button"
import { canStartNewHarness } from "@/lib/harness-policy"
import { readJsonResponse } from "@/lib/http-client"
import type { HarnessId, Lane } from "@/lib/types"


export function LaneSettings({
  lane,
  onClose,
  onUpdated,
  onRemove,
}: {
  lane: Lane
  onClose: () => void
  onUpdated: (lane: Lane) => void
  onRemove: (lane: Lane) => Promise<void>
}) {
  const edition = useDistribution()
  const [name, setName] = useState(lane.name)
  const [note, setNote] = useState("")
  const [defaultHarness, setDefaultHarness] = useState<HarnessId>(lane.defaultHarness)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/lanes/${lane.id}`, { signal: controller.signal })
      .then((response) => readJsonResponse<{ lane: Lane; note: string }>(response, `Request failed (${response.status}).`))
      .then((result) => {
        setName(result.lane.name)
        setDefaultHarness(result.lane.defaultHarness)
        setNote(result.note)
        setLoading(false)
      })
      .catch((cause) => {
        if (controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : `Unable to load ${edition.workItemSingular} settings.`)
        setLoading(false)
      })
    return () => controller.abort()
  }, [edition.workItemSingular, lane.id])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose()
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [onClose, saving])

  const save = async () => {
    try {
      setSaving(true)
      setError("")
      const response = await fetch(`/api/lanes/${lane.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, note, defaultHarness }),
      })
      const result = await readJsonResponse<{ lane: Lane; note: string }>(response, `Request failed (${response.status}).`)
      onUpdated(result.lane)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to save ${edition.workItemSingular} settings.`)
      setSaving(false)
    }
  }

  const unsupportedDefault = !canStartNewHarness(defaultHarness, edition.distributionId)

  return <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="presentation" onMouseDown={() => { if (!saving) onClose() }}>
    <section className="flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="lane-settings-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="flex shrink-0 items-start gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="lane-settings-title" className="text-lg font-semibold">{edition.workItemSingularTitle} settings</h2>
          <p className="mt-1 text-sm text-muted-foreground">Manage this {edition.workItemSingular} without moving or deleting its files.</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} disabled={saving} aria-label={`Close ${edition.workItemSingular} settings`}><X className="size-4" /></Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        <section className="py-5" aria-labelledby="lane-details-heading">
          <h3 id="lane-details-heading" className="text-sm font-semibold">Details</h3>
          <label className="mt-3 grid gap-1.5 text-xs font-medium text-muted-foreground">
            Name
            <input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal text-foreground" />
          </label>
          <label className="mt-4 grid gap-1.5 text-xs font-medium text-muted-foreground">
            {edition.workItemSingularTitle} note
            <textarea value={note} maxLength={4000} rows={4} onChange={(event) => setNote(event.target.value)} placeholder="What should you remember when you return?" className="resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal leading-relaxed text-foreground" />
          </label>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Saved as LANE.md in this folder so the note stays with the work.</p>
        </section>

        <section className="border-t border-border py-5" aria-labelledby="lane-folder-heading">
          <h3 id="lane-folder-heading" className="text-sm font-semibold">Folder</h3>
          <code className="mt-2 block break-all text-xs text-foreground">{lane.path}</code>
          <p className="mt-1.5 text-[11px] text-muted-foreground">The folder cannot be changed here. Removing this {edition.workItemSingular} leaves it and its files in place.</p>
        </section>

        <section className="border-t border-border py-5" aria-labelledby="lane-terminal-heading">
          <h3 id="lane-terminal-heading" className="text-sm font-semibold">New terminals</h3>
          <label className="mt-3 grid gap-1.5 text-xs font-medium text-muted-foreground">
            Default operator
            <select value={defaultHarness} onChange={(event) => setDefaultHarness(event.target.value as HarnessId)} className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal text-foreground">
              {unsupportedDefault ? <option value={defaultHarness} disabled>Unavailable saved provider</option> : null}
              {edition.harnesses.map((harness) => <option key={harness.id} value={harness.id}>{harness.label}</option>)}
            </select>
          </label>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Applies when you add another Agent terminal. Existing terminals are unchanged.</p>
          {unsupportedDefault ? <p className="mt-2 text-xs text-destructive">Choose an available provider before saving.</p> : null}
        </section>
        <OmpIngestPanel lane={lane} onUpdated={onUpdated} />


        <section className="border-t border-border py-5" aria-labelledby="lane-remove-heading">
          <h3 id="lane-remove-heading" className="text-sm font-semibold">Remove from {edition.productName}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Stops this {edition.workItemSingular}’s terminals and removes it from Operator Engine. The folder, its files, and LANE.md stay in place.</p>
          <Button variant="ghost" size="sm" className="mt-3 text-destructive hover:text-destructive" onClick={() => void onRemove(lane)}>Remove {edition.workItemSingular}</Button>
        </section>

        {error ? <p className="mb-5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => void save()} disabled={loading || saving || !name.trim() || unsupportedDefault}>{saving ? "Saving…" : `Save ${edition.workItemSingular}`}</Button>
      </footer>
    </section>
  </div>
}
