"use client"

import { useEffect, useState } from "react"
import { Check, Loader2, RefreshCw } from "lucide-react"

import { useDistribution } from "@/components/distribution-provider"
import { Button } from "@/components/ui/button"
import { readJsonResponse } from "@/lib/http-client"
import type { SafeOmpInventoryItem } from "@/lib/omp-ingest"
import type { Lane } from "@/lib/types"

export function OmpIngestPanel({
  lane,
  onUpdated,
}: {
  lane: Lane
  onUpdated: (lane: Lane) => void
}) {
  const edition = useDistribution()
  const [ompSessions, setOmpSessions] = useState<SafeOmpInventoryItem[]>([])
  const [ompLoading, setOmpLoading] = useState(false)
  const [ompError, setOmpError] = useState("")
  const [ingestingId, setIngestingId] = useState<string | null>(null)

  const loadOmpSessions = async () => {
    try {
      setOmpLoading(true)
      setOmpError("")
      const res = await fetch(`/api/lanes/${lane.id}/ingest-omp`)
      const data = await readJsonResponse<{ provider: string; sessions: SafeOmpInventoryItem[] }>(res, `Failed to load sessions (${res.status}).`)
      setOmpSessions(data.sessions ?? [])
    } catch (err) {
      setOmpError(err instanceof Error ? err.message : "Failed to load sessions.")
    } finally {
      setOmpLoading(false)
    }
  }

  useEffect(() => {
    void loadOmpSessions()
  }, [lane.id])

  const handleIngestOmp = async (sourceSessionId: string) => {
    try {
      setIngestingId(sourceSessionId)
      setOmpError("")
      const res = await fetch(`/api/lanes/${lane.id}/ingest-omp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSessionId }),
      })
      const data = await readJsonResponse<{ ok: boolean; lane: Lane }>(res, `Ingestion failed (${res.status}).`)
      if (data.lane) {
        onUpdated(data.lane)
      }
      await loadOmpSessions()
    } catch (err) {
      setOmpError(err instanceof Error ? err.message : "Ingestion failed.")
    } finally {
      setIngestingId(null)
    }
  }

  return (
    <>
      <section className="border-t border-border py-5" aria-labelledby="lane-omp-ingest-heading">
        <div className="flex items-center justify-between">
          <div>
            <h3 id="lane-omp-ingest-heading" className="text-sm font-semibold">OMP Session Ingestion</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Discover and explicitly import local OMP daily-driver sessions into this {edition.workItemSingular}.</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => void loadOmpSessions()} disabled={ompLoading} aria-label="Refresh session inventory">
            <RefreshCw className={`size-3.5 ${ompLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {ompError ? <p className="mt-2 text-xs text-destructive">{ompError}</p> : null}

        <div className="mt-3 divide-y divide-border rounded-md border border-border bg-background/50">
          {ompLoading && ompSessions.length === 0 ? (
            <div className="flex items-center justify-center p-4 text-xs text-muted-foreground">
              <Loader2 className="mr-2 size-3.5 animate-spin" /> Scanning local sessions…
            </div>
          ) : ompSessions.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              No local sessions discovered. Check your local session directory.
            </div>
          ) : (
            ompSessions.map((session) => {
              const isIngesting = ingestingId === session.sourceSessionId
              const updatedStr = session.updatedAtMs ? new Date(session.updatedAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null
              return (
                <div key={session.sourceSessionId} className="flex items-center justify-between gap-3 p-2.5 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">{session.title}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {updatedStr ? <span>{updatedStr}</span> : null}
                      <span>•</span>
                      <span>{session.messageCount} msg{session.messageCount === 1 ? "" : "s"}</span>
                      {session.alreadyImported ? (
                        <>
                          <span>•</span>
                          <span className="inline-flex items-center gap-0.5 font-medium text-emerald-600 dark:text-emerald-400">
                            <Check className="size-3" /> Ingested
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    variant={session.alreadyImported ? "outline" : "default"}
                    size="sm"
                    disabled={isIngesting}
                    onClick={() => void handleIngestOmp(session.sourceSessionId)}
                    className="h-7 shrink-0 px-2.5 text-xs"
                  >
                    {isIngesting ? <Loader2 className="size-3 animate-spin" /> : session.alreadyImported ? "Re-import" : "Import into lane"}
                  </Button>
                </div>
              )
            })
          )}
        </div>
      </section>

      {lane.threadLinks && lane.threadLinks.length > 0 ? (
        <section className="border-t border-border py-5" aria-labelledby="lane-ingested-threads-heading">
          <h3 id="lane-ingested-threads-heading" className="text-sm font-semibold">Ingested Threads ({lane.threadLinks.length})</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Threads explicitly included in this {edition.workItemSingular}.</p>
          <div className="mt-3 space-y-1.5">
            {lane.threadLinks.map((link) => (
              <div key={link.id} className="rounded-md border border-border bg-background p-2.5 text-xs">
                <div className="font-medium text-foreground">{link.title}</div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Provider: <strong className="font-semibold uppercase">{link.provider}</strong></span>
                  <span>{link.messageCount} messages</span>
                  <span>Imported {new Date(link.importedAt).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  )
}
