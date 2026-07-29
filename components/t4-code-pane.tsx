"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ExternalLink, LoaderCircle, RefreshCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { T4IntegrationConfig } from "@/lib/types"

type T4PaneStatus = "loading" | "ready" | "failed"

export function T4CodePane({ integration }: { integration: T4IntegrationConfig }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<T4PaneStatus>("loading")
  const [armedLoad, setArmedLoad] = useState<string | null>(null)
  const source = useMemo(() => {
    if (integration.url === null) return null
    const url = new URL(integration.url)
    url.searchParams.set("embed", "1")
    return { href: url.toString(), origin: url.origin }
  }, [integration.url])
  const load = useMemo(() => source === null ? null : `${attempt}:${source.href}`, [attempt, source])

  useEffect(() => {
    if (source === null || load === null) return
    setStatus("loading")
    const timeout = window.setTimeout(() => {
      setStatus((current) => current === "loading" ? "failed" : current)
    }, 12_000)
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== source.origin) return
      if (typeof event.data !== "object" || event.data === null) return
      const message = event.data as { type?: unknown; version?: unknown }
      if (message.type !== "t4-code:ready" || message.version !== 1) return
      window.clearTimeout(timeout)
      setStatus("ready")
    }
    window.addEventListener("message", onMessage)
    setArmedLoad(load)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener("message", onMessage)
    }
  }, [load, source])

  if (integration.url === null) {
    return <PaneState
      title={integration.error ? "T4 Code configuration needs attention" : "T4 Code isn't connected"}
      detail={integration.error ?? "Set OPERATOR_ENGINE_T4_URL and restart Operator Engine. Existing layouts stay intact."}
    />
  }

  return <div className="relative h-full min-h-0 bg-background">
    <iframe
      key={load}
      ref={iframeRef}
      title="T4 Code"
      src={armedLoad === load ? source?.href : undefined}
      className="h-full w-full border-0 bg-background"
      sandbox="allow-downloads allow-forms allow-modals allow-same-origin allow-scripts"
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
      onError={() => setStatus("failed")}
    />
    {status === "ready" ? null : <div className="absolute inset-0 grid place-items-center bg-background p-6">
      {status === "loading" ? <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> Opening T4 Code
      </div> : <PaneState
        title="T4 Code didn't open"
        detail="Check that T4 Code is running and allows this Operator Engine origin. Your sessions remain on the T4 host."
        actions={<>
          <Button size="sm" onClick={() => setAttempt((current) => current + 1)}><RefreshCcw className="size-3.5" />Retry</Button>
          <Button size="sm" variant="outline" asChild><a href={integration.url} target="_blank" rel="noreferrer"><ExternalLink className="size-3.5" />Open in new tab</a></Button>
        </>}
      />}
    </div>}
  </div>
}

function PaneState({ title, detail, actions }: { title: string; detail: string; actions?: ReactNode }) {
  return <div className="grid h-full min-h-0 place-items-center bg-background p-6">
    <div className="max-w-sm text-center">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      {actions ? <div className="mt-4 flex justify-center gap-2">{actions}</div> : null}
    </div>
  </div>
}
