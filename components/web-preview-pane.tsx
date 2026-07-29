"use client"

import { type FormEvent, useEffect, useState } from "react"
import { ExternalLink, Globe2, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { webPreviewPaneConfig, type PaneNode } from "@/lib/bento-layout"
import { isBrowserUrl, normalizeBrowserUrl } from "@/lib/browser-location"
import { readJsonResponse } from "@/lib/http-client"

export function WebPreviewPane({
  laneId,
  pane,
  onNavigate,
  onReload,
}: {
  laneId: string
  pane: PaneNode
  onNavigate: (location: string, sourcePaneId: string) => void
  onReload: () => void
}) {
  const config = webPreviewPaneConfig(pane)
  const [address, setAddress] = useState(config.location ?? "")
  const [addressError, setAddressError] = useState("")
  const [liveChanges, setLiveChanges] = useState(0)
  const [watchError, setWatchError] = useState("")
  const isUrl = Boolean(config.location && isBrowserUrl(config.location))

  useEffect(() => setAddress(config.location ?? ""), [config.location])

  useEffect(() => {
    if (!config.location || isBrowserUrl(config.location)) return
    let stopped = false
    let polling = false
    let fingerprint: string | null = null
    setLiveChanges(0)
    setWatchError("")
    const poll = async () => {
      if (stopped || polling) return
      polling = true
      try {
        const response = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/web-preview-version?path=${encodeURIComponent(config.location!)}`, { cache: "no-store" })
        const payload = await readJsonResponse<{ fingerprint?: string }>(response, "The Browser source is unavailable.")
        if (!payload.fingerprint) throw new Error("The Browser source is unavailable.")
        if (fingerprint && fingerprint !== payload.fingerprint) setLiveChanges((current) => current + 1)
        fingerprint = payload.fingerprint
        setWatchError("")
      } catch (error) {
        if (!stopped) setWatchError(error instanceof Error ? error.message : "The Browser source is unavailable.")
      } finally { polling = false }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1_000)
    return () => { stopped = true; clearInterval(timer) }
  }, [config.location, config.revision, laneId])

  const navigate = (event: FormEvent) => {
    event.preventDefault()
    try {
      const requested = address.trim()
      if (!requested) throw new Error("Enter a lane-relative .html path or an HTTP(S) URL.")
      const location = isBrowserUrl(requested) ? normalizeBrowserUrl(requested) : requested
      if (isBrowserUrl(location) && new URL(location).origin === window.location.origin) {
        throw new Error("The Browser cannot embed this application.")
      }
      setAddressError("")
      onNavigate(location, pane.id)
    } catch (error) {
      setAddressError(error instanceof Error ? error.message : "That address is not available.")
    }
  }

  const location = config.location
  const source = !location ? null : isUrl
    ? location
    : `/api/lanes/${encodeURIComponent(laneId)}/web-preview?path=${encodeURIComponent(location)}&revision=${config.revision}-${liveChanges}`
  const embedsClient = Boolean(isUrl && source && typeof window !== "undefined" && new URL(source).origin === window.location.origin)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <form onSubmit={navigate} className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-muted/35 px-2">
        <div className="mr-0.5 hidden items-center gap-1 sm:flex" aria-hidden="true">
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="size-2 rounded-full bg-muted-foreground/25" />
        </div>
        <Button type="button" variant="ghost" size="icon-sm" className="size-7" onClick={onReload} disabled={!location} aria-label="Reload Browser" title="Reload Browser">
          <RefreshCw className="size-3.5" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-border bg-background px-2 shadow-inner focus-within:border-ring">
          <Globe2 className="mr-1.5 size-3 shrink-0 text-muted-foreground" />
          <input
            aria-label="Browser address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="demo/index.html or http://127.0.0.1:3000"
            className="h-7 min-w-0 flex-1 bg-transparent font-mono text-[10px] outline-none placeholder:text-muted-foreground/60"
            spellCheck={false}
          />
        </div>
        <Button type="submit" variant="outline" size="sm" className="h-7 px-2 text-[10px]">Open</Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          disabled={!source}
          onClick={() => source && window.open(source, "_blank", "noopener,noreferrer")}
          aria-label="Open in new tab"
          title="Open in new tab"
        >
          <ExternalLink className="size-3.5" />
        </Button>
      </form>
      {addressError ? <div className="shrink-0 border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-[10px] text-red-300">{addressError}</div> : null}
      <div className="relative min-h-0 flex-1 bg-background">
        {!source ? (
          <div className="grid h-full place-items-center bg-background p-6 text-center">
            <div className="max-w-sm">
              <Globe2 className="mx-auto size-7 text-muted-foreground" />
              <h3 className="mt-3 text-sm font-semibold">Browser ready</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Enter an HTTP(S) URL, open an <code>.html</code> file from Files, or run <code>operator-engine open http://127.0.0.1:3000</code>.
              </p>
            </div>
          </div>
        ) : embedsClient ? (
          <div className="grid h-full place-items-center bg-background p-6 text-center text-xs text-muted-foreground">The Browser cannot embed this application.</div>
        ) : (
          <iframe
            key={`${location}:${config.revision}:${liveChanges}`}
            title={`Browser: ${location}`}
            src={source}
            sandbox={isUrl ? "allow-forms allow-modals allow-same-origin allow-scripts" : "allow-scripts"}
            referrerPolicy="no-referrer"
            className="h-full w-full border-0 bg-background"
          />
        )}
        {watchError ? <div data-browser-source-state="unavailable" className="absolute inset-0 grid place-items-center bg-background p-6 text-center text-foreground"><div className="max-w-sm rounded-xl border border-border bg-card p-4 shadow-lg"><Globe2 className="mx-auto size-6 text-muted-foreground" /><p className="mt-3 text-xs font-medium">Browser source unavailable</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{watchError} Restore the file or choose another address; the Browser will retry automatically.</p></div></div> : null}
      </div>
    </div>
  )
}
