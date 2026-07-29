"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, ExternalLink, Loader2, Play, RotateCcw, TerminalSquare } from "lucide-react"

import "@xterm/xterm/css/xterm.css"

import { Button } from "@/components/ui/button"
import { TerminalShowpiece } from "@/components/terminal-showpiece"
import { useDistribution } from "@/components/distribution-provider"
import { type PaneNode } from "@/lib/bento-layout"
import type { EditionSurfaceId, TerminalShowpieceExperiencePublicV1 } from "@/lib/editions"
import { canStartNewHarness, orderHarnesses } from "@/lib/harness-policy"
import { terminalShowpieceAt, terminalShowpieceCatalog } from "@/lib/terminal-showpiece"
import type { HarnessAvailability, HarnessId, Lane, TerminalBinding, TerminalTicketRequest } from "@/lib/types"
import { terminalRelayUrl } from "@/lib/terminal-relay-url"

type TerminalStatus = "idle" | "connecting" | "open" | "closed" | "error"
type Launch = { ticket: string; bindingGeneration: number; guided: boolean; mode: "attach" | "start" | "resume-exact" | "choose-omp-session"; harnessId: HarnessId }
type ShowpieceRun = { id: number; experience: TerminalShowpieceExperiencePublicV1; complete: boolean }


const harnessPresentation: Record<HarnessId, { description: string }> = {
  omp: { description: "Reviewed agent provider" },
  codex: { description: "Open Codex in this folder" },
  shell: { description: "Native system shell" },
}
let fallbackShowpieceIndex = 0


function availabilityLabel(harness: HarnessAvailability): string {
  if (harness.state === "available") return "Ready"
  if (harness.state === "broken") return "Needs attention"
  return "Not installed"
}



export function TerminalPane({ lane, pane, binding: parentBinding, attachHint, active, onTerminalBinding, onTerminalActivity, onSessionTitle, onSessionStarted }: { lane: Lane; pane: PaneNode; binding: TerminalBinding | null; attachHint: number; active: boolean; onTerminalBinding: (binding: TerminalBinding) => TerminalBinding | null; onTerminalActivity: (paneId: string, bindingGeneration: number, live: boolean) => void; onSessionTitle: (paneId: string, title: string | null) => void; onSessionStarted: (paneId: string) => void }) {
  const edition = useDistribution()
  const hostRef = useRef<HTMLDivElement>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const activeRef = useRef(active)
  const attachHintRef = useRef(attachHint)
  attachHintRef.current = attachHint
  const hasPlayedOnThisMount = useRef(false)
  const autoLaunchRequested = useRef<string | null>(null)
  const bindingRef = useRef<TerminalBinding | null>(parentBinding)
  const harnesses = useMemo(() => orderHarnesses(edition.harnesses, edition.distributionId), [edition.distributionId, edition.harnesses])
  const [binding, setBinding] = useState<TerminalBinding | null>(parentBinding)
  const [loadingHarnesses, setLoadingHarnesses] = useState(false)
  const [harnessId, setHarnessId] = useState<HarnessId>(parentBinding?.harnessId ?? lane.defaultHarness)
  const [showHarnessChoices, setShowHarnessChoices] = useState(false)
  const [status, setStatus] = useState<TerminalStatus>("idle")
  const [error, setError] = useState("")
  const [launch, setLaunch] = useState<Launch | null>(null)
  const [showpieceRun, setShowpieceRun] = useState<ShowpieceRun | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    bindingRef.current = parentBinding
    setBinding(parentBinding)
    if (parentBinding) setHarnessId(parentBinding.harnessId)
  }, [parentBinding])

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReducedMotion(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  const beginShowpiece = useCallback(() => {
    if (hasPlayedOnThisMount.current) return
    hasPlayedOnThisMount.current = true
    const catalog = terminalShowpieceCatalog(edition.active?.terminalShowpiece)
    const storageKey = `operator-engine:terminal-showpiece-index:${edition.active?.id ?? "stock"}`
    let index = fallbackShowpieceIndex
    try {
      const stored = Number(window.sessionStorage.getItem(storageKey))
      index = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0
      window.sessionStorage.setItem(storageKey, String(index + 1))
    } catch {
      fallbackShowpieceIndex += 1
    }
    setShowpieceRun({ id: Date.now(), experience: terminalShowpieceAt(catalog, index), complete: false })
  }, [edition.active?.id, edition.active?.terminalShowpiece])

  const completeShowpiece = useCallback((runId: number) => {
    setShowpieceRun((current) => current?.id === runId ? { ...current, complete: true } : current)
  }, [])

  useEffect(() => {
    if (!showpieceRun?.complete) return
    const timer = window.setTimeout(() => setShowpieceRun((current) => current?.id === showpieceRun.id ? null : current), 180)
    return () => window.clearTimeout(timer)
  }, [showpieceRun?.complete, showpieceRun?.id])

  const detect = () => {
    setLoadingHarnesses(true)
    setError("")
    void edition.refresh()
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Harness detection failed."))
      .finally(() => setLoadingHarnesses(false))
  }

  const selected = useMemo(() => harnesses.find((item) => item.id === harnessId), [harnessId, harnesses])
  const guidanceAvailable = Boolean(lane.recipeId && selected?.supportsGuidance && binding && !binding.kickoffSent)

  const requestLaunch = useCallback(async (request: TerminalTicketRequest, showpiece: boolean) => {
    if (!bindingRef.current) throw new Error("Terminal pane has no durable binding.")
    if (showpiece) beginShowpiece()
    setStatus("connecting")
    setError("")
    const response = await fetch("/api/terminal-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
    const payload = await response.json().catch(() => ({})) as {
      ticket?: string
      binding?: TerminalBinding
      mode?: Launch["mode"]
      guidanceIncluded?: boolean
      error?: string
    }
    if (!response.ok) {
      const current = bindingRef.current
      if (payload.binding) {
        const accepted = onTerminalBinding(payload.binding)
        if (accepted) {
          bindingRef.current = accepted
          setBinding(accepted)
          if (!current
              || accepted.generation !== current.generation
              || accepted.harnessId !== current.harnessId) setHarnessId(accepted.harnessId)
        }
      }
      throw new Error(payload.error || `Request failed (${response.status}).`)
    }
    if (!payload.ticket || !payload.binding || !payload.mode) throw new Error("Terminal ticket response is incomplete.")
    const current = bindingRef.current
    const accepted = onTerminalBinding(payload.binding)
    if (!accepted) throw new Error("Terminal ticket no longer applies to this pane.")
    bindingRef.current = accepted
    setBinding(accepted)
    if (!current
        || accepted.generation !== current.generation
        || accepted.harnessId !== current.harnessId) setHarnessId(accepted.harnessId)
    if (accepted.generation !== payload.binding.generation || accepted.harnessId !== payload.binding.harnessId) {
      throw new Error("Terminal changed before its ticket could be used.")
    }
    autoLaunchRequested.current = `${accepted.generation}:${attachHintRef.current}`
    setLaunch({
      ticket: payload.ticket,
      bindingGeneration: accepted.generation,
      guided: payload.guidanceIncluded === true,
      mode: payload.mode,
      harnessId: accepted.harnessId,
    })
    if (request.action !== "attach") onTerminalActivity(pane.id, accepted.generation, false)
  }, [beginShowpiece, onTerminalActivity, onTerminalBinding, pane.id])

  const start = useCallback(async (guided = guidanceAvailable, newSession = false) => {
    const current = bindingRef.current
    if (!current) {
      setStatus("error")
      setError("Terminal pane has no durable binding.")
      return
    }
    try {
      onSessionTitle(pane.id, null)
      const request: TerminalTicketRequest = newSession
        ? { laneId: lane.id, paneId: pane.id, action: "new-session", harnessId, expectedGeneration: current.generation }
        : { laneId: lane.id, paneId: pane.id, action: "start", harnessId, expectedGeneration: current.generation, useGuidance: guided }
      await requestLaunch(request, true)
    } catch (cause) {
      setStatus("error")
      setShowpieceRun(null)
      setError(cause instanceof Error ? cause.message : "Terminal failed to start.")
    }
  }, [guidanceAvailable, harnessId, lane.id, onSessionTitle, pane.id, requestLaunch])

  const resumeBound = useCallback(async () => {
    const current = bindingRef.current
    if (!current?.resumeSessionId) {
      setStatus("error")
      setError("No exact OMP session is bound to this pane.")
      return
    }
    try {
      await requestLaunch({
        laneId: lane.id,
        paneId: pane.id,
        action: "resume-bound",
        expectedGeneration: current.generation,
      }, false)
    } catch (cause) {
      setStatus("error")
      setShowpieceRun(null)
      setError(cause instanceof Error ? cause.message : "Exact OMP session could not be resumed.")
    }
  }, [lane.id, pane.id, requestLaunch])

  const chooseOmpSession = useCallback(async () => {
    const current = bindingRef.current
    if (!current) {
      setStatus("error")
      setError("Terminal pane has no durable binding.")
      return
    }
    try {
      onSessionTitle(pane.id, null)
      await requestLaunch({
        laneId: lane.id,
        paneId: pane.id,
        action: "choose-omp-session",
        expectedGeneration: current.generation,
      }, true)
    } catch (cause) {
      setStatus("error")
      setShowpieceRun(null)
      setError(cause instanceof Error ? cause.message : "OMP session picker failed to start.")
    }
  }, [lane.id, onSessionTitle, pane.id, requestLaunch])

  useEffect(() => {
    const startNewSession = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string }>).detail
      if (detail?.paneId === pane.id) void start(false, true)
    }
    window.addEventListener("operator-engine:terminal-new-session", startNewSession)
    return () => window.removeEventListener("operator-engine:terminal-new-session", startNewSession)
  }, [pane.id, start])

  useEffect(() => {
    if (!binding) {
      setStatus("error")
      setError("Terminal pane has no durable binding.")
      return
    }
    if (launch?.bindingGeneration === binding.generation && (status === "connecting" || status === "open")) return
    const key = `${binding.generation}:${attachHint}`
    if (autoLaunchRequested.current === key) return
    autoLaunchRequested.current = key
    if (!canStartNewHarness(binding.harnessId, edition.distributionId)) {
      setStatus("idle")
      return
    }
    let cancelled = false
    void requestLaunch({ laneId: lane.id, paneId: pane.id, action: "attach" }, false).catch((cause) => {
      if (cancelled) return
      setError(cause instanceof Error ? cause.message : "Unable to attach this terminal.")
      setStatus("error")
    })
    return () => { cancelled = true }
  }, [attachHint, binding, edition.distributionId, lane.id, launch, pane.id, requestLaunch, status])
  useEffect(() => {
    if (!launch) return
    const host = hostRef.current
    if (!host) return
    const hostElement = host
    const currentLaunch = launch
    let disposed = false
    let resizeObserver: ResizeObserver | null = null
    let terminal: import("@xterm/xterm").Terminal | null = null
    let fit: import("@xterm/addon-fit").FitAddon | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let terminalFailure = false

    async function attachTicket(): Promise<string | null> {
      const response = await fetch("/api/terminal-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ laneId: lane.id, paneId: pane.id, action: "attach" }),
      })
      const payload = await response.json().catch(() => ({})) as {
        ticket?: string
        binding?: TerminalBinding
        mode?: Launch["mode"]
        error?: string
      }
      if (!response.ok) {
        if (payload.binding) {
          const accepted = onTerminalBinding(payload.binding)
          if (accepted) {
            bindingRef.current = accepted
            setBinding(accepted)
            setHarnessId(accepted.harnessId)
            return null
          }
        }
        throw new Error(payload.error || `Request failed (${response.status}).`)
      }
      if (!payload.ticket || !payload.binding || payload.mode !== "attach") throw new Error("Terminal attach response is incomplete.")
      const accepted = onTerminalBinding(payload.binding)
      if (!accepted) return null
      bindingRef.current = accepted
      setBinding(accepted)
      setHarnessId(accepted.harnessId)
      if (accepted.generation !== payload.binding.generation || accepted.harnessId !== payload.binding.harnessId) return null
      if (accepted.generation !== currentLaunch.bindingGeneration) {
        autoLaunchRequested.current = `${accepted.generation}:${attachHintRef.current}`
        setLaunch({
          ticket: payload.ticket,
          bindingGeneration: accepted.generation,
          guided: false,
          mode: "attach",
          harnessId: accepted.harnessId,
        })
        return null
      }
      return payload.ticket
    }

    function scheduleReconnect() {
      if (disposed || reconnectTimer) return
      reconnectAttempt += 1
      setStatus("connecting")
      setError("")
      const delay = Math.min(5_000, 400 * (2 ** Math.min(reconnectAttempt - 1, 4)))
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null
        try {
          const ticket = await attachTicket()
          if (ticket) openSocket(ticket, "attach")
        } catch {
          scheduleReconnect()
        }
      }, delay)
    }

    function openSocket(ticket: string, mode: Launch["mode"]) {
      if (disposed) return
      let missingSession = false
      let processExited = false
      const socket = new WebSocket(terminalRelayUrl(window.location, ticket, edition.runtimeIdentity.terminalPort))
      socketRef.current = socket
      socket.onopen = () => {
        if (bindingRef.current?.generation !== currentLaunch.bindingGeneration) {
          socket.close(4409, "Terminal generation replaced")
          return
        }
        reconnectAttempt = 0
        terminalFailure = false
        setStatus("open")
        setError("")
        socket.send(JSON.stringify({ kind: "resize", cols: terminal?.cols ?? 100, rows: terminal?.rows ?? 30 }))
      }
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          kind: string
          generation?: number
          data?: string
          message?: string
          title?: string
          binding?: TerminalBinding
        }
        if (bindingRef.current?.generation !== currentLaunch.bindingGeneration) {
          socket.close(4409, "Terminal generation replaced")
          return
        }
        if (message.generation !== currentLaunch.bindingGeneration) return
        if (message.kind === "missing") {
          missingSession = true
          const current = bindingRef.current
          if (mode === "attach" && current?.generation === currentLaunch.bindingGeneration && current.resumeSessionId) {
            setStatus("connecting")
            void resumeBound()
          } else if (current?.generation === currentLaunch.bindingGeneration && current.resumeSessionId) {
            terminalFailure = true
            setLaunch(null)
            setError("Exact OMP session could not be resumed.")
            setStatus("error")
          } else {
            setStatus("idle")
            setLaunch(null)
          }
          return
        }
        if (message.kind === "binding" && message.binding?.paneId === pane.id && message.binding.generation === currentLaunch.bindingGeneration) {
          const accepted = onTerminalBinding(message.binding)
          if (accepted?.generation === currentLaunch.bindingGeneration) {
            bindingRef.current = accepted
            setBinding(accepted)
            setHarnessId(accepted.harnessId)
            onTerminalActivity(pane.id, accepted.generation, true)
          }
        }
        if (message.kind === "output" && message.data) terminal?.write(message.data)
        if (message.kind === "status" && message.message) terminal?.writeln(`\r\n\x1b[90m${message.message}\x1b[0m`)
        if (message.kind === "session" && message.title) onSessionTitle(pane.id, message.title)
        if (message.kind === "started") {
          const current = bindingRef.current
          if (current?.generation === currentLaunch.bindingGeneration) {
            onTerminalActivity(pane.id, current.generation, true)
            onSessionStarted(pane.id)
          }
        }
        if (message.kind === "exit") {
          processExited = true
          setStatus("closed")
          setShowpieceRun(null)
        }
        if (message.kind === "error") {
          terminalFailure = true
          setShowpieceRun(null)
          setError(message.message ?? "Terminal error.")
          setStatus("error")
        }
      }
      socket.onerror = () => undefined
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        if (disposed || missingSession || processExited || terminalFailure) return
        scheduleReconnect()
      }
    }

    function routePasteToTerminal(event: ClipboardEvent) {
      if (!activeRef.current || !terminal || event.defaultPrevented) return
      const target = event.target
      if (target instanceof Node && hostElement.contains(target)) return
      const targetElement = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
      if (targetElement?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return
      const text = event.clipboardData?.getData("text/plain")
      if (!text) return
      event.preventDefault()
      terminal.paste(text)
      terminal.focus()
    }

    async function connect() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      if (disposed) return
      terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: '"JetBrains Mono", "Cascadia Code", ui-monospace, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 10_000,
        theme: { background: "#09090b", foreground: "#e7e5e4", cursor: "#d6d3d1", selectionBackground: "#44403c", black: "#18181b", red: "#fb7185", green: "#a3e635", yellow: "#facc15", blue: "#7dd3fc", magenta: "#c4b5fd", cyan: "#67e8f9", white: "#e7e5e4" },
      })
      fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(hostElement)
      fit.fit()
      openSocket(currentLaunch.ticket, currentLaunch.mode)
      terminal.onData((data) => { const socket = socketRef.current; if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "input", data })) })
      resizeObserver = new ResizeObserver(() => {
        fit?.fit()
        const socket = socketRef.current
        if (socket?.readyState === WebSocket.OPEN && terminal) socket.send(JSON.stringify({ kind: "resize", cols: terminal.cols, rows: terminal.rows }))
      })
      resizeObserver.observe(hostElement)
    }
    connect().catch((cause) => { if (!disposed) { setError(cause instanceof Error ? cause.message : "Terminal failed."); setStatus("error") } })
    window.addEventListener("paste", routePasteToTerminal, true)
    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      window.removeEventListener("paste", routePasteToTerminal, true)
      resizeObserver?.disconnect()
      socketRef.current?.close()
      socketRef.current = null
      terminal?.dispose()
    }
  }, [edition.runtimeIdentity.terminalPort, lane.id, launch, onSessionStarted, onSessionTitle, onTerminalActivity, onTerminalBinding, pane.id, resumeBound])

  const availableHarnesses = harnesses.filter((item) => canStartNewHarness(item.id, edition.distributionId))
  const selectedOverride = selected && selected.id !== "codex" ? edition.surface(`agent-card:${selected.id}` as EditionSurfaceId) : undefined
  const canChangeHarness = availableHarnesses.some((item) => item.id !== harnessId)

  const showpieceOverlay = showpieceRun ? (
    <div className={`absolute inset-0 z-10 transition-opacity duration-[180ms] ${showpieceRun.complete ? "opacity-0" : "opacity-100"}`}>
      <TerminalShowpiece experience={showpieceRun.experience} runId={showpieceRun.id} reducedMotion={reducedMotion} onComplete={completeShowpiece} />
    </div>
  ) : null

  const renderHarnessCard = (item: HarnessAvailability, displayOnly: boolean) => {
    const presentation = harnessPresentation[item.id]
    const slot = `agent-card:${item.id}` as EditionSurfaceId
    const override = edition.surface(slot)
    if (override?.visibility === "hidden") return null
    const active = item.id === harnessId
    const disabled = displayOnly || item.state !== "available" || override?.interaction === "display-only"
    return (
      <button
        key={item.id}
        data-operator-engine-slot={slot}
        data-operator-engine-walkthrough-target={item.id === "omp" ? "operator" : undefined}
        type="button"
        role="radio"
        aria-checked={active}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={() => setHarnessId(item.id)}
        className={`group relative min-h-28 overflow-hidden rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-500/70 disabled:cursor-not-allowed disabled:opacity-65 ${active ? "border-lime-500/70 bg-lime-500/10" : "border-border bg-background/70 hover:border-muted-foreground/40 hover:bg-accent"}`}
      >
        {override?.backgroundUrl ? <img data-operator-engine-background src={override.backgroundUrl} alt="" className="pointer-events-none absolute inset-0 size-full object-cover opacity-45" /> : null}
        {override?.decorationUrl ? <img data-operator-engine-decoration src={override.decorationUrl} alt="" className="pointer-events-none absolute inset-x-0 bottom-0 w-full opacity-25" /> : null}
        <span className="flex items-start justify-between gap-2">
          <span className="grid size-9 place-items-center overflow-hidden rounded-lg border border-border bg-secondary">
            {override?.iconUrl ? <img src={override.iconUrl} alt="" className="size-8 object-contain p-1" /> : <TerminalSquare className="size-5 text-foreground" />}
          </span>
          {override?.badge ? <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-orange-700 dark:text-orange-200">{override.badge}</span> : <span className={`mt-0.5 size-2 rounded-full ${item.state === "available" ? "bg-lime-400" : item.state === "broken" ? "bg-amber-400" : "bg-stone-600"}`} />}
        </span>
        <span className="relative mt-2 block text-xs font-semibold text-foreground">{override?.label ?? item.label}</span>
        <span className="relative mt-0.5 block text-[10px] leading-4 text-muted-foreground">{override?.description ?? presentation.description}</span>
        <span className={`mt-2 block text-[10px] ${item.state === "available" ? "text-lime-700 dark:text-lime-300" : "text-muted-foreground"}`}>{availabilityLabel(item)}</span>
      </button>
    )
  }

  if (!launch && status === "connecting" && showpieceRun) {
    return (
      <div data-terminal-state="connecting" className="relative h-full min-h-0 overflow-hidden bg-zinc-950">
        {showpieceOverlay}
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded border border-white/10 bg-black/70 px-2 py-1 text-[10px] text-stone-400"><Loader2 className="size-3 animate-spin" /> connecting</div>
      </div>
    )
  }

  if (!binding) {
    return <div data-terminal-state="invariant-error" className="grid h-full place-items-center bg-background p-6 text-center text-foreground"><div className="max-w-sm"><AlertCircle className="mx-auto size-6 text-destructive" /><h3 className="mt-3 text-sm font-semibold">Terminal binding unavailable</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">This terminal pane cannot start until its durable binding is restored.</p></div></div>
  }

  const dormantProvider = !canStartNewHarness(binding.harnessId, edition.distributionId)
  if (!launch && dormantProvider) {
    return <div data-terminal-state="dormant" className="grid h-full place-items-center bg-background p-6 text-center text-foreground"><div className="max-w-sm"><TerminalSquare className="mx-auto size-6 text-muted-foreground" /><h3 className="mt-3 text-sm font-semibold">Provider unavailable</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">This saved terminal is dormant in the current product. Its saved session and files are unchanged.</p></div></div>
  }

  if (!launch && binding.resumeSessionId && status !== "error") {
    return <div data-terminal-state="connecting" className="grid h-full place-items-center bg-zinc-950 text-stone-400"><div className="flex items-center gap-2 text-xs"><Loader2 className="size-3.5 animate-spin" /> Reattaching exact session</div></div>
  }

  if (!launch && status !== "error") {
    return (
      <div data-terminal-state="ready" className="grid h-full place-items-center bg-background p-5 text-foreground">
        <div data-terminal-preflight data-distribution-onboarding-target="agent-terminal" className="w-full max-w-xl p-2">
          <div className="flex items-center gap-2"><TerminalSquare className="size-4 text-muted-foreground" /><h3 className="text-sm font-semibold">Open a terminal</h3></div>
          <p className="mt-1 text-xs text-muted-foreground">Nothing starts until you open it.</p>
          <div data-selected-agent className="mt-4 flex items-center gap-3 border-y border-border py-3">
            <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-secondary">
              {selectedOverride?.iconUrl ? <img src={selectedOverride.iconUrl} alt="" className="size-8 object-contain p-1" /> : <TerminalSquare className="size-5 text-foreground" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-foreground">{selectedOverride?.label ?? selected?.label ?? "Agent"}</span>
              <span className="mt-0.5 block text-[10px] text-muted-foreground">{loadingHarnesses ? "Checking availability…" : selected ? availabilityLabel(selected) : "Unavailable"}</span>
            </span>
            {canChangeHarness ? <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-expanded={showHarnessChoices} aria-controls={`available-agent-choices-${pane.id}`} onClick={() => setShowHarnessChoices((current) => !current)}>{showHarnessChoices ? "Done" : "Change"}</Button> : null}
          </div>
          {showHarnessChoices ? <fieldset id={`available-agent-choices-${pane.id}`} className="mt-3" disabled={loadingHarnesses}>
            <legend className="sr-only">Available agents</legend>
            <div role="radiogroup" aria-label="Available agents" className="grid grid-cols-2 gap-2">
              {availableHarnesses.map((item) => renderHarnessCard(item, false))}
            </div>
          </fieldset> : null}
          {selected?.state !== "available" && selected?.help ? <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-800 dark:text-amber-200"><p>{selected.help}</p><p className="mt-1 text-muted-foreground">Install it yourself from the official project documentation, then check again. {edition.productName} never installs tools or collects credentials.</p><a className="mt-2 inline-flex items-center gap-1 text-amber-700 underline dark:text-amber-300" href={selected.id === "codex" ? "https://developers.openai.com/codex/cli/" : "https://github.com/can1357/oh-my-pi"} target="_blank" rel="noreferrer">Official install/help <ExternalLink className="size-3" /></a><Button className="mt-2" size="sm" variant="outline" onClick={detect}><RotateCcw className="size-3" /> Check again</Button></div> : null}
          {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
          {!binding.resumeSessionId && harnessId === "omp" ? <Button className="mt-4 w-full" variant="outline" disabled={loadingHarnesses || !harnesses.some((item) => item.id === "omp" && item.state === "available")} onClick={() => void chooseOmpSession()}><RotateCcw className="size-3.5" /> Choose local OMP session</Button> : null}
          <Button className={`${!binding.resumeSessionId && harnessId === "omp" ? "mt-2" : "mt-4"} w-full`} disabled={loadingHarnesses || !selected || !canStartNewHarness(selected.id, edition.distributionId) || selected.state !== "available"} onClick={() => void start()}><Play className="size-3.5" /> Open {selected?.label ?? "terminal"} in this folder</Button>
        </div>
      </div>
    )
  }

  return (
    <div data-terminal-state={status === "idle" ? "connecting" : status} className="relative h-full min-h-0 overflow-hidden bg-zinc-950">
      <div ref={hostRef} className="h-full min-h-0 p-2 [&_.xterm]:h-full [&_.xterm-viewport]:!overflow-y-auto" />
      {showpieceOverlay}
      {status === "connecting" ? <div className="absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded border border-white/10 bg-black/70 px-2 py-1 text-[10px] text-stone-400"><Loader2 className="size-3 animate-spin" /> connecting</div> : null}
      {(status === "closed" || status === "error") ? (
        <div className="absolute inset-x-3 bottom-3 z-30 rounded-lg border border-white/15 bg-zinc-900/95 p-3 text-stone-200 shadow-xl">
          <div className="flex items-center gap-2 text-xs"><AlertCircle className="size-3.5 text-amber-300" />{error || "The terminal exited."}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {binding.resumeSessionId
              ? <Button size="sm" variant="outline" onClick={() => void resumeBound()}><RotateCcw className="size-3" /> Retry exact session</Button>
              : <Button size="sm" variant="outline" onClick={() => void start(false)}><RotateCcw className="size-3" /> Retry normally</Button>}
            {!binding.resumeSessionId && guidanceAvailable ? <Button size="sm" onClick={() => void start(true)}><RotateCcw className="size-3" /> Retry with recipe guidance</Button> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
