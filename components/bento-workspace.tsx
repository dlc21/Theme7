"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, Maximize2, Minimize2, MoreHorizontal, RotateCcw, Box, GripHorizontal, GripVertical, Plus, X } from "lucide-react"
import { AlertDialog, DropdownMenu } from "radix-ui"

import { paneRegistry } from "@/components/pane-registry"
import { useDistribution } from "@/components/distribution-provider"
import { Button } from "@/components/ui/button"
import {
  defaultLayout, findFirstPaneByType, findPane, insertPane, movePane, openWebPreview, paneIds, parseSavedLayout, removePane, replacePane, terminalPane, updatePane, updateSplit, webPreviewPaneConfig,
  type DropZone, type LayoutNode, type PaneNode, type SplitNode,
} from "@/lib/bento-layout"
import type { ClientControlIntent } from "@/lib/client-control-intents"
import { readJsonResponse } from "@/lib/http-client"
import type { Lane, LaneLayoutState, SavedLayoutV1, T4IntegrationConfig, TerminalBinding } from "@/lib/types"
import { browserStorageGet, browserStorageSet, cn } from "@/lib/utils"


export type PanePaletteController = {
  paneCounts: Readonly<Record<string, number>>
  t4Integration: T4IntegrationConfig
  onAdd: (type: string) => void
  onDragStart: (type: string) => void
  onDragEnd: () => void
}

type OmpPrewarmReservation = { laneId: string; pane: PaneNode; binding: TerminalBinding; expiresAt: number }
type ClosingTerminalReview = { pane: PaneNode; expectedGeneration: number }
type TerminalCloseOutcome = "closed" | "missing" | "binding-stale" | "invalid-last" | "retryable"
type LayoutSaveOutcome = "saved" | "conflict" | "failed" | "superseded"
type QueuedLayoutSave = { saved: SavedLayoutV1; resolve: (outcome: LayoutSaveOutcome) => void }
type CachedLayoutV2 = { layout: SavedLayoutV1; layoutRevision: number }
type LaneRefreshHint =
  | { kind: "layout"; layoutRevision: number }
  | { kind: "binding"; paneId: string; bindingGeneration: number; live: boolean }


function layoutKey(laneId: string) { return `operator-engine:bento:v2:${laneId}` }
function terminalCloseConfirmationKey(laneId: string) { return `operator-engine:terminal-close-confirm:v1:${laneId}` }
function laneRefreshChannelName(laneId: string) { return `operator-engine:lane-layout:v1:${laneId}` }

function countPanesByType(node: LayoutNode): Record<string, number> {
  const counts: Record<string, number> = {}
  const visit = (current: LayoutNode) => {
    if (current.kind === "pane") {
      counts[current.pane] = (counts[current.pane] ?? 0) + 1
      return
    }
    if (current.kind === "tabs") {
      for (const pane of current.panes) visit(pane)
      return
    }
    visit(current.first)
    visit(current.second)
  }
  visit(node)
  return counts
}


function freshPane(type: string, prewarmedOmp: PaneNode | null = null): PaneNode {
  if (type === "terminal" && prewarmedOmp) return prewarmedOmp
  const definition = paneRegistry[type]
  if (!definition) throw new Error(`Unknown pane type ${type}.`)
  return definition.create({ role: "additional" })
}
function firstUnregisteredPane(node: LayoutNode): PaneNode | null {
  if (node.kind === "pane") return paneRegistry[node.pane] ? null : node
  if (node.kind === "tabs") {
    for (const pane of node.panes) {
      if (!paneRegistry[pane.pane]) return pane
    }
    return null
  }
  return firstUnregisteredPane(node.first) ?? firstUnregisteredPane(node.second)
}

function visibleLayout(saved: SavedLayoutV1): SavedLayoutV1 {
  let tree: LayoutNode | null = saved.tree
  let hidden = firstUnregisteredPane(tree)
  while (hidden && tree) {
    tree = removePane(tree, hidden.id)
    hidden = tree ? firstUnregisteredPane(tree) : null
  }
  return tree === saved.tree ? saved : { schemaVersion: 1, tree: tree ?? defaultLayout() }
}

function mergeTerminalBinding(current: TerminalBinding | undefined, incoming: TerminalBinding): TerminalBinding {
  if (!current || incoming.generation > current.generation) return incoming
  if (incoming.generation < current.generation) return current
  if (current.harnessId !== incoming.harnessId ||
      (current.resumeSessionId && incoming.resumeSessionId && current.resumeSessionId !== incoming.resumeSessionId)) {
    console.error(`Ignored contradictory terminal binding update for ${incoming.paneId} generation ${incoming.generation}.`)
    return current
  }
  const resumeSessionId = current.resumeSessionId ?? incoming.resumeSessionId
  const kickoffSent = current.kickoffSent || incoming.kickoffSent
  const updatedAt = current.updatedAt >= incoming.updatedAt ? current.updatedAt : incoming.updatedAt
  if (resumeSessionId === current.resumeSessionId
      && kickoffSent === current.kickoffSent
      && updatedAt === current.updatedAt) return current
  return {
    paneId: current.paneId,
    harnessId: current.harnessId,
    resumeSessionId,
    kickoffSent,
    generation: current.generation,
    updatedAt,
  }
}

function mergeCanonicalBindings(
  current: Record<string, TerminalBinding>,
  incoming: Record<string, TerminalBinding>,
  tree: LayoutNode,
): Record<string, TerminalBinding> {
  const merged: Record<string, TerminalBinding> = {}
  for (const paneId of paneIds(tree)) {
    const pane = findPane(tree, paneId)
    if (pane?.pane !== "terminal") continue
    const candidate = incoming[paneId]
    if (candidate) merged[paneId] = mergeTerminalBinding(current[paneId], candidate)
  }
  const currentKeys = Object.keys(current)
  const mergedKeys = Object.keys(merged)
  return currentKeys.length === mergedKeys.length
    && mergedKeys.every((paneId) => current[paneId] === merged[paneId])
    ? current
    : merged
}



export function BentoWorkspace({ lane, t4Integration, onPanePaletteChange, onTerminalStarted, previewRequest, onPreviewRequestHandled }: { lane: Lane; t4Integration: T4IntegrationConfig; onPanePaletteChange?: (controller: PanePaletteController | null) => void; onTerminalStarted?: () => void; previewRequest?: { token: number; location: string }; onPreviewRequestHandled?: (token: number, result: "opened" | "unavailable") => void }) {
  const edition = useDistribution()
  const initial = visibleLayout(lane.layout ?? { schemaVersion: 1 as const, tree: defaultLayout() })
  const [layout, setLayout] = useState<LayoutNode>(initial.tree)
  const [activePaneId, setActivePaneId] = useState(paneIds(initial.tree)[0] ?? "")
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null)
  const [palettePane, setPalettePane] = useState<PaneNode | null>(null)
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string | null>(null)
  const [restartingPane, setRestartingPane] = useState<PaneNode | null>(null)
  const [closingPane, setClosingPane] = useState<ClosingTerminalReview | null>(null)
  const [confirmTerminalClose, setConfirmTerminalClose] = useState(true)
  const [skipCloseConfirmation, setSkipCloseConfirmation] = useState(false)
  const [terminalTitles, setTerminalTitles] = useState<Record<string, string>>({})
  const [terminalBindings, setTerminalBindings] = useState<Record<string, TerminalBinding>>(lane.terminalBindings)
  const terminalBindingsRef = useRef(terminalBindings)
  terminalBindingsRef.current = terminalBindings
  const [terminalAttachHint, setTerminalAttachHint] = useState(0)
  const [layoutSaveError, setLayoutSaveError] = useState<string | null>(null)
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null)
  const [terminalClosePending, setTerminalClosePending] = useState(false)
  const saveTimer = useRef<number | undefined>(undefined)
  const layoutRevisionRef = useRef(lane.layoutRevision)
  const queuedLayoutRef = useRef<QueuedLayoutSave | null>(null)
  const saveInFlightRef = useRef<Promise<void> | null>(null)
  const saveAbortRef = useRef<AbortController | null>(null)
  const laneRefreshChannelRef = useRef<BroadcastChannel | null>(null)
  const saveFailedRef = useRef(false)
  const flushSaveRef = useRef<() => void>(() => undefined)
  const handledPreviewRequest = useRef(0)
  const onTerminalStartedRef = useRef(onTerminalStarted)
  onTerminalStartedRef.current = onTerminalStarted
  const closeBarrierRef = useRef(false)
  const closeInFlightRef = useRef(false)
  const hydratedLaneIdRef = useRef(lane.id)
  const hydratedOnceRef = useRef(false)
  const layoutRef = useRef(layout)
  const [ompPrewarm, setOmpPrewarm] = useState<OmpPrewarmReservation | null>(null)
  const [ompPrewarmPaneId, setOmpPrewarmPaneId] = useState("")
  const [ompPrewarmAttempt, setOmpPrewarmAttempt] = useState(0)
  const [ompPrewarmUnavailable, setOmpPrewarmUnavailable] = useState(false)
  const ompPrewarmRef = useRef<OmpPrewarmReservation | null>(null)
  const ompPrewarmRetryRef = useRef<number | undefined>(undefined)
  const ompPrewarmInsertionRef = useRef<{ paneId: string; generation: number } | null>(null)
  const terminalInsertionRef = useRef<string | null>(null)


  const installTerminalBindings = useCallback((next: Record<string, TerminalBinding>) => {
    if (terminalBindingsRef.current === next) return
    terminalBindingsRef.current = next
    setTerminalBindings(next)
  }, [])
  const cache = useCallback((saved: SavedLayoutV1, layoutRevision = layoutRevisionRef.current) => {
    const payload: CachedLayoutV2 = { layout: saved, layoutRevision }
    browserStorageSet(layoutKey(lane.id), JSON.stringify(payload))
  }, [lane.id])

  const flushSave = useCallback(() => {
    if (saveInFlightRef.current || saveFailedRef.current || !queuedLayoutRef.current) return
    const request = queuedLayoutRef.current
    queuedLayoutRef.current = null
    const baseRevision = layoutRevisionRef.current
    const controller = new AbortController()
    saveAbortRef.current = controller
    const operation = (async () => {
      try {
        const response = await fetch(`/api/lanes/${lane.id}/layout`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ layout: request.saved, baseRevision }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null) as (LaneLayoutState & { code?: string; error?: string }) | null
        if (response.status === 409 && payload?.code === "LAYOUT_CONFLICT") {
          queuedLayoutRef.current?.resolve("conflict")
          queuedLayoutRef.current = null
          const canonical = parseSavedLayout(payload.layout)
          if (canonical && Number.isSafeInteger(payload.layoutRevision) && payload.layoutRevision >= layoutRevisionRef.current) {
            layoutRevisionRef.current = payload.layoutRevision
            installTerminalBindings(mergeCanonicalBindings(terminalBindingsRef.current, payload.terminalBindings, canonical.tree))
            layoutRef.current = canonical.tree
            setLayout(canonical.tree)
            setActivePaneId(paneIds(canonical.tree)[0] ?? "")
            setFullscreenPaneId(null)
            setClosingPane(null)
            setRestartingPane(null)
            cache(canonical, payload.layoutRevision)
            setTerminalAttachHint((value) => value + 1)
          }
          saveFailedRef.current = false
          setLayoutSaveError(null)
          setLayoutNotice("Layout changed in another window. The current layout was reloaded.")
          request.resolve("conflict")
          return
        }
        if (!response.ok || !payload || !Number.isSafeInteger(payload.layoutRevision)) {
          throw new Error(payload?.error || `Layout save failed (${response.status}).`)
        }
        if (payload.layoutRevision >= layoutRevisionRef.current) {
          layoutRevisionRef.current = payload.layoutRevision
          const canonical = parseSavedLayout(payload.layout)
          if (canonical) {
            installTerminalBindings(mergeCanonicalBindings(terminalBindingsRef.current, payload.terminalBindings, canonical.tree))
            if (!queuedLayoutRef.current) {
              layoutRef.current = canonical.tree
              setLayout(canonical.tree)
            }
          }
          cache(
            queuedLayoutRef.current?.saved ?? { schemaVersion: 1, tree: layoutRef.current },
            payload.layoutRevision,
          )
        }
        saveFailedRef.current = false
        setLayoutSaveError(null)
        laneRefreshChannelRef.current?.postMessage({
          kind: "layout",
          layoutRevision: payload.layoutRevision,
        } satisfies LaneRefreshHint)
        request.resolve("saved")
      } catch {
        if (controller.signal.aborted) {
          request.resolve("failed")
          return
        }
        request.resolve("failed")
        if (!queuedLayoutRef.current) {
          queuedLayoutRef.current = { saved: request.saved, resolve: () => undefined }
        }
        saveFailedRef.current = true
        setLayoutSaveError("Layout changes were not saved.")
      }
    })()
    saveInFlightRef.current = operation
    void operation.finally(() => {
      if (saveInFlightRef.current === operation) saveInFlightRef.current = null
      if (saveAbortRef.current === controller) saveAbortRef.current = null
      if (queuedLayoutRef.current && !saveFailedRef.current) queueMicrotask(() => flushSaveRef.current())
    })
  }, [cache, installTerminalBindings, lane.id])
  flushSaveRef.current = flushSave

  const queueLayoutSave = useCallback((saved: SavedLayoutV1, immediate = false, optimisticCache = true): Promise<LayoutSaveOutcome> => {
    if (optimisticCache) cache(saved)
    if (queuedLayoutRef.current) queuedLayoutRef.current.resolve("superseded")
    const { promise: outcome, resolve } = Promise.withResolvers<LayoutSaveOutcome>()
    queuedLayoutRef.current = { saved, resolve }
    clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    if (!saveFailedRef.current) {
      if (immediate) flushSaveRef.current()
      else saveTimer.current = window.setTimeout(() => flushSaveRef.current(), 350)
    }
    return outcome
  }, [cache])

  const retryLayoutSave = useCallback(() => {
    if (!queuedLayoutRef.current) return
    saveFailedRef.current = false
    setLayoutSaveError(null)
    flushSaveRef.current()
  }, [])

  useEffect(() => {
    const sameLane = hydratedLaneIdRef.current === lane.id
    if (hydratedOnceRef.current && sameLane && lane.layoutRevision === layoutRevisionRef.current) {
      const merged = mergeCanonicalBindings(terminalBindingsRef.current, lane.terminalBindings, layoutRef.current)
      if (merged !== terminalBindingsRef.current) {
        installTerminalBindings(merged)
        setTerminalAttachHint((value) => value + 1)
      }
      return
    }
    if (sameLane && lane.layoutRevision < layoutRevisionRef.current) return
    saveAbortRef.current?.abort()
    clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    queuedLayoutRef.current?.resolve("superseded")
    queuedLayoutRef.current = null
    saveFailedRef.current = false
    setLayoutSaveError(null)
    setLayoutNotice(null)
    hydratedLaneIdRef.current = lane.id
    layoutRevisionRef.current = lane.layoutRevision
    hydratedOnceRef.current = true
    const server = lane.layout
    let cached: SavedLayoutV1 | null = null
    if (!server) {
      try {
        const v2 = JSON.parse(browserStorageGet(layoutKey(lane.id)) ?? "null") as Partial<CachedLayoutV2> | null
        if (v2 && Number.isSafeInteger(v2.layoutRevision)) cached = parseSavedLayout(v2.layout)
      } catch { cached = null }
    }
    const source = server ?? cached ?? { schemaVersion: 1 as const, tree: defaultLayout() }
    const selected = visibleLayout(source)
    installTerminalBindings(sameLane
      ? mergeCanonicalBindings(terminalBindingsRef.current, lane.terminalBindings, selected.tree)
      : mergeCanonicalBindings({}, lane.terminalBindings, selected.tree))
    setTerminalAttachHint((value) => value + 1)
    layoutRef.current = selected.tree
    setLayout(selected.tree)
    setActivePaneId(paneIds(selected.tree)[0] ?? "")
    setFullscreenPaneId(null)
    setClosingPane(null)
    setRestartingPane(null)
    setSkipCloseConfirmation(false)
    setConfirmTerminalClose(browserStorageGet(terminalCloseConfirmationKey(lane.id)) !== "0")
    setTerminalTitles({})
    cache(selected, lane.layoutRevision)
    if (!server || selected !== source) void queueLayoutSave(selected, true)
  }, [cache, installTerminalBindings, lane.id, lane.layout, lane.layoutRevision, lane.terminalBindings, queueLayoutSave])
  useEffect(() => () => {
    clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    saveAbortRef.current?.abort()
    queuedLayoutRef.current?.resolve("superseded")
    queuedLayoutRef.current = null
  }, [lane.id])

  useEffect(() => {
    ompPrewarmRef.current = null
    ompPrewarmInsertionRef.current = null
    setOmpPrewarm(null)
    setOmpPrewarmPaneId("")
    setOmpPrewarmAttempt(0)
    setOmpPrewarmUnavailable(false)
    return () => {
      clearTimeout(ompPrewarmRetryRef.current)
      ompPrewarmRef.current = null
      ompPrewarmInsertionRef.current = null
    }
  }, [lane.id])

  useEffect(() => {
    const eligible = edition.distributionId === "theme-7" && lane.defaultHarness === "omp"
    if (!eligible) {
      const reservation = ompPrewarmRef.current
      if (reservation?.laneId === lane.id) {
        void fetch("/api/terminal-prewarm", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            laneId: reservation.laneId,
            paneId: reservation.pane.id,
            expectedGeneration: reservation.binding.generation,
          }),
          keepalive: true,
        }).catch(() => undefined)
      }
      ompPrewarmRef.current = null
      ompPrewarmInsertionRef.current = null
      setOmpPrewarm(null)
      setOmpPrewarmPaneId("")
      return
    }
    if (ompPrewarm || ompPrewarmPaneId || ompPrewarmUnavailable || findFirstPaneByType(layout, "terminal")) return
    const paneId = `terminal-${crypto.randomUUID()}`
    setOmpPrewarmPaneId(paneId)
    setOmpPrewarmAttempt(0)
  }, [edition.distributionId, lane.defaultHarness, lane.id, layout, ompPrewarm, ompPrewarmPaneId, ompPrewarmUnavailable])

  useEffect(() => {
    if (edition.distributionId !== "theme-7" || lane.defaultHarness !== "omp" || !ompPrewarmPaneId || ompPrewarm || ompPrewarmUnavailable) return
    const controller = new AbortController()
    type PrewarmPayload = {
      enabled?: boolean
      expiresAt?: number
      binding?: TerminalBinding | null
      error?: string
    }
    const requestPrewarm = async (expectedGeneration?: number) => {
      const response = await fetch("/api/terminal-prewarm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          laneId: lane.id,
          paneId: ompPrewarmPaneId,
          ...(expectedGeneration ? { expectedGeneration } : {}),
        }),
        cache: "no-store",
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => ({})) as PrewarmPayload
      return { response, payload }
    }
    const validBinding = (binding: TerminalBinding | null | undefined): binding is TerminalBinding =>
      Boolean(binding
        && binding.paneId === ompPrewarmPaneId
        && binding.harnessId === "omp"
        && Number.isSafeInteger(binding.generation)
        && binding.generation > 0)
    void (async () => {
      let result = await requestPrewarm()
      if (result.response.status === 409 && validBinding(result.payload.binding)) {
        const conflictedBinding = result.payload.binding
        result = await requestPrewarm(conflictedBinding.generation)
      }
      if (!result.response.ok) {
        if (result.response.status === 404 && result.payload.enabled === false) {
          setOmpPrewarmUnavailable(true)
          return
        }
        throw new Error(result.payload.error || "OMP prewarm failed.")
      }
      if (!Number.isFinite(result.payload.expiresAt) || !validBinding(result.payload.binding)) {
        throw new Error("OMP prewarm failed.")
      }
      const binding = result.payload.binding
      const reservation: OmpPrewarmReservation = {
        laneId: lane.id,
        pane: terminalPane(ompPrewarmPaneId, "additional"),
        binding,
        expiresAt: result.payload.expiresAt!,
      }
      if (controller.signal.aborted) return
      ompPrewarmRef.current = reservation
      setOmpPrewarmAttempt(0)
      setOmpPrewarm(reservation)
    })().catch(() => {
      if (controller.signal.aborted) return
      if (ompPrewarmAttempt >= 3) {
        setOmpPrewarmUnavailable(true)
        return
      }
      clearTimeout(ompPrewarmRetryRef.current)
      ompPrewarmRetryRef.current = window.setTimeout(() => setOmpPrewarmAttempt((attempt) => attempt + 1), 1_500)
    })
    return () => controller.abort()
  }, [edition.distributionId, lane.defaultHarness, lane.id, ompPrewarm, ompPrewarmAttempt, ompPrewarmPaneId, ompPrewarmUnavailable])

  useEffect(() => {
    if (!ompPrewarm) return
    let stopped = false
    let retryTimer: number | undefined
    const cancel = () => {
      void fetch("/api/terminal-prewarm", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          laneId: ompPrewarm.laneId,
          paneId: ompPrewarm.pane.id,
          expectedGeneration: ompPrewarm.binding.generation,
        }),
        keepalive: true,
      }).catch(() => undefined)
    }
    const renew = async () => {
      let stale = false
      try {
        const response = await fetch("/api/terminal-prewarm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            laneId: ompPrewarm.laneId,
            paneId: ompPrewarm.pane.id,
            expectedGeneration: ompPrewarm.binding.generation,
          }),
          cache: "no-store",
        })
        const payload = await response.json().catch(() => ({})) as {
          expiresAt?: number
          binding?: TerminalBinding | null
          error?: string
        }
        if (!response.ok) {
          stale = response.status === 409
          throw new Error(payload.error || "OMP prewarm renewal failed.")
        }
        if (!Number.isFinite(payload.expiresAt)
          || payload.binding?.paneId !== ompPrewarm.pane.id
          || payload.binding.harnessId !== "omp"
          || payload.binding.generation !== ompPrewarm.binding.generation) {
          stale = true
          throw new Error("OMP prewarm renewal changed identity.")
        }
        if (stopped) return
        const renewedBinding = mergeTerminalBinding(ompPrewarm.binding, payload.binding)
        const renewed = { ...ompPrewarm, binding: renewedBinding, expiresAt: payload.expiresAt! }
        ompPrewarmRef.current = renewed
        setOmpPrewarm((current) => current?.pane.id === ompPrewarm.pane.id
          && current.binding.generation === ompPrewarm.binding.generation ? renewed : current)
      } catch {
        if (stopped) return
        if (stale) {
          cancel()
          ompPrewarmRef.current = null
          setOmpPrewarm(null)
          setOmpPrewarmPaneId("")
          setOmpPrewarmUnavailable(true)
        } else if (Date.now() < ompPrewarm.expiresAt) {
          retryTimer = window.setTimeout(() => void renew(), Math.min(5_000, Math.max(250, ompPrewarm.expiresAt - Date.now())))
        } else {
          ompPrewarmRef.current = null
          setOmpPrewarm(null)
          setOmpPrewarmPaneId("")
          setOmpPrewarmAttempt((attempt) => attempt + 1)
        }
      }
    }
    const renewalTimer = window.setTimeout(() => void renew(), Math.max(1_000, ompPrewarm.expiresAt - Date.now() - 15_000))
    return () => {
      stopped = true
      clearTimeout(renewalTimer)
      clearTimeout(retryTimer)
    }
  }, [ompPrewarm])

  useEffect(() => {
    if (!ompPrewarm || !findFirstPaneByType(layout, "terminal")) return
    if (ompPrewarmInsertionRef.current?.paneId === ompPrewarm.pane.id
      && ompPrewarmInsertionRef.current.generation === ompPrewarm.binding.generation) return
    if (ompPrewarmRef.current?.pane.id === ompPrewarm.pane.id
      && ompPrewarmRef.current.binding.generation === ompPrewarm.binding.generation) {
      ompPrewarmRef.current = null
    }
    setOmpPrewarm(null)
    setOmpPrewarmPaneId("")
    void fetch("/api/terminal-prewarm", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        laneId: ompPrewarm.laneId,
        paneId: ompPrewarm.pane.id,
        expectedGeneration: ompPrewarm.binding.generation,
      }),
      keepalive: true,
    }).catch(() => undefined)
  }, [layout, ompPrewarm])

  const commit = useCallback((next: LayoutNode) => {
    if (closeBarrierRef.current) {
      setLayoutSaveError("A terminal close is still being saved.")
      return
    }
    if (ompPrewarmInsertionRef.current || terminalInsertionRef.current) {
      setLayoutSaveError("A terminal addition is still being saved.")
      return
    }
    layoutRef.current = next
    setLayout(next)
    void queueLayoutSave({ schemaVersion: 1, tree: next })
  }, [queueLayoutSave])
  const acceptTerminalBinding = useCallback((incoming: TerminalBinding): TerminalBinding | null => {
    const pane = findPane(layoutRef.current, incoming.paneId)
    if (pane?.pane !== "terminal") return null
    const accepted = mergeTerminalBinding(terminalBindingsRef.current[incoming.paneId], incoming)
    installTerminalBindings({
      ...terminalBindingsRef.current,
      [incoming.paneId]: accepted,
    })
    return accepted
  }, [installTerminalBindings])

  const adoptCanonicalState = useCallback((state: LaneLayoutState): boolean => {
    if (!Number.isSafeInteger(state.layoutRevision) || state.layoutRevision < layoutRevisionRef.current || !state.layout) return false
    const canonical = parseSavedLayout(state.layout)
    if (!canonical) return false
    layoutRevisionRef.current = state.layoutRevision
    layoutRef.current = canonical.tree
    setLayout(canonical.tree)
    installTerminalBindings(mergeCanonicalBindings(terminalBindingsRef.current, state.terminalBindings, canonical.tree))
    setActivePaneId((current) => findPane(canonical.tree, current)?.id ?? paneIds(canonical.tree)[0] ?? "")
    setFullscreenPaneId((current) => current && findPane(canonical.tree, current) ? current : null)
    setClosingPane((current) => current && findPane(canonical.tree, current.pane.id) ? current : null)
    setRestartingPane((current) => current && findPane(canonical.tree, current.id) ? current : null)
    cache(canonical, state.layoutRevision)
    setTerminalAttachHint((value) => value + 1)
    return true
  }, [cache, installTerminalBindings])

  const publishTerminalActivity = useCallback((paneId: string, bindingGeneration: number, live: boolean) => {
    const pane = findPane(layoutRef.current, paneId)
    const binding = terminalBindingsRef.current[paneId]
    if (pane?.pane !== "terminal" || binding?.generation !== bindingGeneration) return
    laneRefreshChannelRef.current?.postMessage({
      kind: "binding",
      paneId,
      bindingGeneration,
      live,
    } satisfies LaneRefreshHint)
  }, [])

  useEffect(() => {
    if (typeof BroadcastChannel !== "function") return
    const channel = new BroadcastChannel(laneRefreshChannelName(lane.id))
    const pendingBindings = new Map<string, { generation: number; live: boolean; timer?: number }>()
    const bindingRefreshes = new Set<string>()
    let pendingLayoutRevision: number | null = null
    let layoutRefreshInFlight = false
    let closed = false

    const hasLocalVisualWork = () => Boolean(
      queuedLayoutRef.current
      || saveInFlightRef.current
      || saveFailedRef.current
      || closeBarrierRef.current
      || ompPrewarmInsertionRef.current,
    )

    async function refreshLayout() {
      if (closed || layoutRefreshInFlight || pendingLayoutRevision === null) return
      if (hasLocalVisualWork()) {
        pendingLayoutRevision = null
        return
      }
      const expectedRevision = pendingLayoutRevision
      pendingLayoutRevision = null
      if (expectedRevision <= layoutRevisionRef.current) return
      layoutRefreshInFlight = true
      try {
        const response = await fetch(`/api/lanes/${encodeURIComponent(lane.id)}/layout`, { cache: "no-store" })
        const state = await response.json().catch(() => null) as LaneLayoutState | null
        if (closed || hasLocalVisualWork() || !response.ok || !state
          || !Number.isSafeInteger(state.layoutRevision)
          || state.layoutRevision < expectedRevision
          || state.layoutRevision < layoutRevisionRef.current) return
        adoptCanonicalState(state)
      } finally {
        layoutRefreshInFlight = false
        if (pendingLayoutRevision !== null) queueMicrotask(() => void refreshLayout())
      }
    }

    function scheduleBindingRefresh(paneId: string, delay: number) {
      const pending = pendingBindings.get(paneId)
      if (!pending || pending.timer !== undefined) return
      pending.timer = window.setTimeout(() => {
        const current = pendingBindings.get(paneId)
        if (current) current.timer = undefined
        void refreshBinding(paneId)
      }, delay)
    }

    async function refreshBinding(paneId: string) {
      if (closed || bindingRefreshes.has(paneId)) return
      const hint = pendingBindings.get(paneId)
      if (!hint) return
      if (hint.timer !== undefined) clearTimeout(hint.timer)
      pendingBindings.delete(paneId)
      bindingRefreshes.add(paneId)
      try {
        const response = await fetch(`/api/lanes/${encodeURIComponent(lane.id)}/layout`, { cache: "no-store" })
        const state = await response.json().catch(() => null) as LaneLayoutState | null
        if (closed || !response.ok || !state?.layout) return
        const canonical = parseSavedLayout(state.layout)
        const currentPane = findPane(layoutRef.current, paneId)
        const canonicalPane = canonical ? findPane(canonical.tree, paneId) : null
        const incoming = state.terminalBindings[paneId]
        if (currentPane?.pane !== "terminal" || canonicalPane?.pane !== "terminal"
          || !incoming || incoming.generation < hint.generation) return
        const accepted = acceptTerminalBinding(incoming)
        if (accepted && accepted.generation >= hint.generation) {
          setTerminalAttachHint((value) => value + 1)
        }
      } finally {
        bindingRefreshes.delete(paneId)
        const queued = pendingBindings.get(paneId)
        if (queued?.live) queueMicrotask(() => void refreshBinding(paneId))
        else if (queued) scheduleBindingRefresh(paneId, 1_000)
      }
    }

    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data
      if (!message || typeof message !== "object") return
      if ("kind" in message && message.kind === "layout"
        && "layoutRevision" in message
        && Number.isSafeInteger(message.layoutRevision)
        && Number(message.layoutRevision) >= 0) {
        if (hasLocalVisualWork() || Number(message.layoutRevision) <= layoutRevisionRef.current) return
        pendingLayoutRevision = Math.max(pendingLayoutRevision ?? 0, Number(message.layoutRevision))
        void refreshLayout()
        return
      }
      if (!("kind" in message) || message.kind !== "binding"
        || !("paneId" in message) || typeof message.paneId !== "string"
        || !("bindingGeneration" in message) || !Number.isSafeInteger(message.bindingGeneration)
        || Number(message.bindingGeneration) < 1
        || !("live" in message) || typeof message.live !== "boolean") return
      const paneId = message.paneId
      const generation = Number(message.bindingGeneration)
      const current = pendingBindings.get(paneId)
      if (current && generation < current.generation) return
      if (!current || generation > current.generation) {
        if (current?.timer !== undefined) clearTimeout(current.timer)
        pendingBindings.set(paneId, { generation, live: message.live })
      } else if (message.live) {
        current.live = true
      }
      const pending = pendingBindings.get(paneId)!
      if (pending.live) {
        if (pending.timer !== undefined) {
          clearTimeout(pending.timer)
          pending.timer = undefined
        }
        void refreshBinding(paneId)
      } else {
        scheduleBindingRefresh(paneId, 1_000)
      }
    }
    laneRefreshChannelRef.current = channel
    return () => {
      closed = true
      for (const pending of pendingBindings.values()) {
        if (pending.timer !== undefined) clearTimeout(pending.timer)
      }
      pendingBindings.clear()
      channel.close()
      if (laneRefreshChannelRef.current === channel) laneRefreshChannelRef.current = null
    }
  }, [acceptTerminalBinding, adoptCanonicalState, lane.id])

  const insertPrewarmedTerminal = useCallback(async (
    reservation: OmpPrewarmReservation,
    targetId: string,
    zone: DropZone,
  ) => {
    if (ompPrewarmInsertionRef.current || closeBarrierRef.current) return
    const current = layoutRef.current
    if (findPane(current, reservation.pane.id) || !findPane(current, targetId)) return
    const owner = { paneId: reservation.pane.id, generation: reservation.binding.generation }
    const saved: SavedLayoutV1 = {
      schemaVersion: 1,
      tree: insertPane(current, targetId, reservation.pane, zone),
    }
    ompPrewarmInsertionRef.current = owner

    const sameOwner = () => ompPrewarmInsertionRef.current?.paneId === owner.paneId
      && ompPrewarmInsertionRef.current.generation === owner.generation
    const releaseReservation = (retry: boolean) => {
      if (ompPrewarmRef.current?.pane.id === owner.paneId
        && ompPrewarmRef.current.binding.generation === owner.generation) {
        ompPrewarmRef.current = null
        setOmpPrewarm(null)
        setOmpPrewarmPaneId("")
        if (retry) setOmpPrewarmAttempt((attempt) => attempt + 1)
        else setOmpPrewarmAttempt(0)
      }
    }
    const cancelReservation = () => {
      void fetch("/api/terminal-prewarm", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          laneId: reservation.laneId,
          paneId: owner.paneId,
          expectedGeneration: owner.generation,
        }),
        keepalive: true,
      }).catch(() => undefined)
    }
    const clearFailedInsertionSave = () => {
      if (queuedLayoutRef.current?.saved === saved) {
        queuedLayoutRef.current.resolve("superseded")
        queuedLayoutRef.current = null
      }
      saveFailedRef.current = false
      setLayoutSaveError(null)
      if (queuedLayoutRef.current) queueMicrotask(() => flushSaveRef.current())
    }
    const reconcile = async (): Promise<boolean> => {
      try {
        const response = await fetch(`/api/lanes/${encodeURIComponent(lane.id)}/layout`, { cache: "no-store" })
        const payload = await response.json().catch(() => null) as LaneLayoutState | null
        if (!response.ok || !payload || !adoptCanonicalState(payload)) return false
        clearFailedInsertionSave()
        const canonicalPane = payload.layout ? findPane(payload.layout.tree, owner.paneId) : null
        const canonicalBinding = payload.terminalBindings[owner.paneId]
        ompPrewarmInsertionRef.current = null
        if (canonicalPane?.pane === "terminal") {
          releaseReservation(false)
          setActivePaneId(owner.paneId)
          if (canonicalBinding?.generation !== owner.generation) cancelReservation()
          return true
        }
        releaseReservation(true)
        cancelReservation()
        return true
      } catch {
        return false
      }
    }

    await queueLayoutSave(saved, true, false)
    while (sameOwner()) {
      if (await reconcile()) return
      const live = ompPrewarmRef.current
      if (!live || live.pane.id !== owner.paneId || live.binding.generation !== owner.generation) {
        ompPrewarmInsertionRef.current = null
        return
      }
      if (Date.now() >= live.expiresAt) {
        clearFailedInsertionSave()
        ompPrewarmInsertionRef.current = null
        releaseReservation(true)
        cancelReservation()
        return
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      window.setTimeout(resolve, 1_000)
      await promise
    }
  }, [adoptCanonicalState, lane.id, queueLayoutSave])

  const flushPendingLayout = useCallback(async (): Promise<boolean> => {
    clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    while (true) {
      if (saveFailedRef.current) return false
      flushSaveRef.current()
      const inFlight = saveInFlightRef.current
      if (inFlight) {
        await inFlight
        continue
      }
      if (!queuedLayoutRef.current) return true
      await Promise.resolve()
    }
  }, [])

  const serializeTerminalClose = useCallback(async (paneId: string, expectedGeneration: number): Promise<TerminalCloseOutcome> => {
    if (ompPrewarmInsertionRef.current) {
      setLayoutSaveError("A terminal addition must finish saving before another terminal can close.")
      return "retryable"
    }
    if (closeInFlightRef.current) return "retryable"
    closeInFlightRef.current = true
    closeBarrierRef.current = true
    setTerminalClosePending(true)
    try {
      if (!(await flushPendingLayout())) {
        setLayoutSaveError("Layout changes must be saved before closing a terminal.")
        return "retryable"
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const currentPane = findPane(layoutRef.current, paneId)
        if (!currentPane) return "missing"
        if (currentPane.pane !== "terminal") return "binding-stale"
        let response: Response
        try {
          response = await fetch(`/api/lanes/${encodeURIComponent(lane.id)}/panes/${encodeURIComponent(paneId)}`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ baseRevision: layoutRevisionRef.current, expectedGeneration }),
          })
        } catch {
          response = new Response(null, { status: 599 })
        }
        const payload = await response.json().catch(() => null) as (LaneLayoutState & {
          code?: string
          error?: string
          cleanupError?: string
        }) | null
        if (response.ok && payload && adoptCanonicalState(payload)) {
          setTerminalTitles((titles) => {
            if (!(paneId in titles)) return titles
            const next = { ...titles }
            delete next[paneId]
            return next
          })
          setLayoutSaveError(null)
          setLayoutNotice(payload.cleanupError ?? null)
          laneRefreshChannelRef.current?.postMessage({
            kind: "layout",
            layoutRevision: payload.layoutRevision,
          } satisfies LaneRefreshHint)
          return "closed"
        }
        if (response.status === 409 && payload?.code === "LAYOUT_CONFLICT") {
          adoptCanonicalState(payload)
          if (attempt === 0) continue
          return "retryable"
        }
        if (response.status === 409 && payload?.code === "TERMINAL_BINDING_CHANGED") {
          adoptCanonicalState(payload)
          return "binding-stale"
        }
        if (response.status === 400 && payload?.code === "INVALID_LAST_PANE") return "invalid-last"
        if (response.status === 404) return "missing"

        try {
          const canonicalResponse = await fetch(`/api/lanes/${encodeURIComponent(lane.id)}/layout`, { cache: "no-store" })
          const canonical = await canonicalResponse.json().catch(() => null) as LaneLayoutState | null
          if (canonicalResponse.ok && canonical && adoptCanonicalState(canonical) && !findPane(canonical.layout!.tree, paneId)) {
            laneRefreshChannelRef.current?.postMessage({
              kind: "layout",
              layoutRevision: canonical.layoutRevision,
            } satisfies LaneRefreshHint)
            return "closed"
          }
        } catch {
          // The canonical GET below is the final authority for an unknown close response.
        }
        return "retryable"
      }
      return "retryable"
    } finally {
      closeBarrierRef.current = false
      closeInFlightRef.current = false
      setTerminalClosePending(false)
    }
  }, [adoptCanonicalState, flushPendingLayout, lane.id])
  const openPreview = useCallback((location: string, sourcePaneId: string, deterministicId?: string) => {
    const current = layoutRef.current
    const existing = findFirstPaneByType(current, "web-preview")
    const paneId = existing?.id ?? deterministicId ?? `web-preview-${crypto.randomUUID()}`
    const next = openWebPreview(current, { location, sourcePaneId, newPaneId: paneId })
    commit(next)
    setActivePaneId(paneId)
  }, [commit])
  useEffect(() => {
    if (!previewRequest || handledPreviewRequest.current === previewRequest.token) return
    handledPreviewRequest.current = previewRequest.token
    let cancelled = false
    const handle = async () => {
      const response = await fetch(`/api/lanes/${encodeURIComponent(lane.id)}/web-preview-version?path=${encodeURIComponent(previewRequest.location)}`, { cache: "no-store" })
      if (!response.ok) { if (!cancelled) onPreviewRequestHandled?.(previewRequest.token, "unavailable"); return }
      let current = layoutRef.current
      let source = findFirstPaneByType(current, "terminal")
      if (!source) {
        source = terminalPane("web-preview-tour-terminal", "additional")
        current = insertPane(current, paneIds(current)[0]!, source, "right")
      }
      const existing = findFirstPaneByType(current, "web-preview")
      const paneId = existing?.id ?? "web-preview-tour"
      const next = openWebPreview(current, { location: previewRequest.location, sourcePaneId: source.id, newPaneId: paneId })
      layoutRef.current = next
      setLayout(next)
      setActivePaneId(paneId)
      const outcome = await queueLayoutSave({ schemaVersion: 1, tree: next }, true)
      if (!cancelled) onPreviewRequestHandled?.(previewRequest.token, outcome === "saved" ? "opened" : "unavailable")
    }
    void handle().catch(() => { if (!cancelled) onPreviewRequestHandled?.(previewRequest.token, "unavailable") })
    return () => { cancelled = true }
  }, [lane.defaultHarness, lane.id, onPreviewRequestHandled, previewRequest, queueLayoutSave])
  const reloadPreview = useCallback((paneId: string) => {
    const next = updatePane(layoutRef.current, paneId, (pane) => {
      const config = webPreviewPaneConfig(pane)
      return { ...pane, config: { ...config, revision: config.revision + 1 } }
    })
    commit(next)
  }, [commit])
  const clearClosedPaneState = useCallback((paneId: string, next: LayoutNode) => {
    setTerminalTitles((titles) => {
      if (!(paneId in titles)) return titles
      const nextTitles = { ...titles }
      delete nextTitles[paneId]
      return nextTitles
    })
    setActivePaneId(paneIds(next)[0] ?? "")
    setFullscreenPaneId((currentId) => currentId === paneId ? null : currentId)
  }, [])
  const closePaneFromControlIntent = useCallback(async (intent: Extract<ClientControlIntent, { kind: "close_terminal" }>) => {
    const acknowledgeUrl = `/api/lanes/${lane.id}/control-intents?intentId=${encodeURIComponent(intent.id)}`
    const outcome = await serializeTerminalClose(intent.sourcePaneId, intent.expectedGeneration)
    if (outcome === "retryable") return
    if (outcome === "invalid-last") setLayoutSaveError("This Agent Terminal is the only pane in the lane.")
    if (outcome === "binding-stale") setLayoutSaveError("This terminal changed before the close command could be applied.")
    await fetch(acknowledgeUrl, { method: "DELETE" })
  }, [lane.id, serializeTerminalClose])

  useEffect(() => {
    let stopped = false
    let polling = false
    const poll = async () => {
      if (stopped || polling) return
      polling = true
      try {
        const response = await fetch(`/api/lanes/${lane.id}/control-intents`, { cache: "no-store" })
        if (!response.ok) return
        const payload = await readJsonResponse<{ intents?: ClientControlIntent[] }>(response, "Operator Engine control intents are unavailable.")
        for (const intent of payload.intents ?? []) {
          if (stopped) break
          switch (intent.kind) {
            case "open_web_preview": {
              const current = layoutRef.current
              const existing = findFirstPaneByType(current, "web-preview")
              const paneId = existing?.id ?? `web-preview-${intent.id}`
              const next = openWebPreview(current, { location: intent.location, sourcePaneId: intent.sourcePaneId, newPaneId: paneId })
              const saved: SavedLayoutV1 = { schemaVersion: 1, tree: next }
              layoutRef.current = next
              setLayout(next)
              setActivePaneId(paneId)
              clearTimeout(saveTimer.current)
              saveTimer.current = undefined
              const outcome = await queueLayoutSave(saved, true)
              if (outcome === "saved") {
                await fetch(`/api/lanes/${lane.id}/control-intents?intentId=${encodeURIComponent(intent.id)}`, { method: "DELETE" })
              }
              break
            }
            case "close_terminal": {
              await closePaneFromControlIntent(intent)
              break
            }
          }
        }
      } catch {
        // The next poll retries; a transient control-path failure must not disturb the lane.
      } finally { polling = false }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1_000)
    return () => { stopped = true; clearInterval(timer) }
  }, [closePaneFromControlIntent, lane.id, queueLayoutSave])
  const addPane = useCallback((type: string, targetId = activePaneId, zone: DropZone = "right") => {
    const definition = paneRegistry[type]
    if (definition?.distributionId && definition.distributionId !== edition.distributionId) return
    if (definition?.singleton) {
      const existing = findFirstPaneByType(layout, type)
      if (existing) { commit(updatePane(layout, existing.id, (pane) => pane)); setActivePaneId(existing.id); return }
    }
    const ids = paneIds(layout)
    const target = ids.includes(targetId) ? targetId : ids[0]
    if (!target) return
    if (type === "terminal" && ompPrewarm && !findPane(layout, ompPrewarm.pane.id)) {
      void insertPrewarmedTerminal(ompPrewarm, target, zone)
      return
    }
    if (type === "terminal") {
      if (terminalInsertionRef.current) {
        setLayoutSaveError("A terminal addition is still being saved.")
        return
      }
      const pane = freshPane(type)
      const next = insertPane(layout, target, pane, zone)
      terminalInsertionRef.current = pane.id
      void (async () => {
        try {
          const outcome = await queueLayoutSave({ schemaVersion: 1, tree: next }, true, false)
          if (outcome === "saved" && findPane(layoutRef.current, pane.id)?.pane === "terminal") {
            setActivePaneId(pane.id)
          }
        } finally {
          if (terminalInsertionRef.current === pane.id) terminalInsertionRef.current = null
        }
      })()
      return
    }
    const pane = freshPane(type)
    commit(insertPane(layout, target, pane, zone))
    setActivePaneId(pane.id)
  }, [activePaneId, commit, edition.distributionId, insertPrewarmedTerminal, layout, ompPrewarm, queueLayoutSave])
  const addTerminalTab = useCallback((targetId: string) => addPane("terminal", targetId, "center"), [addPane])
  const closeVisualPane = useCallback((pane: PaneNode) => {
    const current = layoutRef.current
    if (paneIds(current).length <= 1) return
    const next = removePane(current, pane.id)
    if (next) {
      commit(next)
      clearClosedPaneState(pane.id, next)
    }
  }, [clearClosedPaneState, commit])
  const updateTerminalCloseConfirmation = useCallback((enabled: boolean) => {
    setConfirmTerminalClose(enabled)
    browserStorageSet(terminalCloseConfirmationKey(lane.id), enabled ? "1" : "0")
  }, [lane.id])
  const closeReviewedTerminal = useCallback(async (review: ClosingTerminalReview) => {
    const outcome = await serializeTerminalClose(review.pane.id, review.expectedGeneration)
    if (outcome === "closed" || outcome === "missing") {
      setClosingPane(null)
      return
    }
    if (outcome === "binding-stale") {
      setClosingPane(null)
      setLayoutSaveError("This terminal changed in another window. Review it again before closing.")
      return
    }
    if (outcome === "invalid-last") {
      setClosingPane(null)
      setLayoutSaveError("This Agent Terminal is the only pane in the lane.")
      return
    }
    setLayoutSaveError("Terminal close could not be confirmed. Retry after the current layout is available.")
  }, [serializeTerminalClose])
  const requestClosePane = useCallback((pane: PaneNode) => {
    if (pane.pane !== "terminal") {
      closeVisualPane(pane)
      return
    }
    if (paneIds(layoutRef.current).length <= 1) {
      setLayoutSaveError("This Agent Terminal is the only pane in the lane.")
      return
    }
    const binding = terminalBindings[pane.id]
    if (!binding) {
      setLayoutSaveError("Terminal pane has no binding.")
      return
    }
    const review = { pane, expectedGeneration: binding.generation }
    if (!confirmTerminalClose) {
      void closeReviewedTerminal(review)
      return
    }
    setActivePaneId(pane.id)
    setSkipCloseConfirmation(false)
    setClosingPane(review)
  }, [closeReviewedTerminal, closeVisualPane, confirmTerminalClose, terminalBindings])
  const confirmClosePane = useCallback(() => {
    if (!closingPane || terminalClosePending) return
    if (skipCloseConfirmation) updateTerminalCloseConfirmation(false)
    void closeReviewedTerminal(closingPane)
  }, [closeReviewedTerminal, closingPane, skipCloseConfirmation, terminalClosePending, updateTerminalCloseConfirmation])
  const confirmNewTerminalSession = useCallback(() => {
    if (!restartingPane) return
    const pane = restartingPane
    setRestartingPane(null)
    window.dispatchEvent(new CustomEvent("operator-engine:terminal-new-session", { detail: { paneId: pane.id } }))
  }, [restartingPane])
  const updateTerminalTitle = useCallback((paneId: string, title: string | null) => {
    setTerminalTitles((current) => {
      if (!title) {
        if (!(paneId in current)) return current
        const next = { ...current }
        delete next[paneId]
        return next
      }
      return current[paneId] === title ? current : { ...current, [paneId]: title }
    })
  }, [])
  const consumeOmpPrewarm = useCallback((paneId: string) => {
    const reservation = ompPrewarmRef.current
    if (reservation?.pane.id !== paneId) return
    ompPrewarmRef.current = null
    setOmpPrewarm(null)
    setOmpPrewarmPaneId("")
    setOmpPrewarmAttempt(0)
  }, [])
  const terminalStarted = useCallback((paneId: string) => {
    consumeOmpPrewarm(paneId)
    onTerminalStartedRef.current?.()
  }, [consumeOmpPrewarm])
  const fullscreenPane = fullscreenPaneId ? findPane(layout, fullscreenPaneId) : null
  const paneCounts = useMemo(() => countPanesByType(layout), [layout])

  useEffect(() => {
    if (fullscreenPane) {
      onPanePaletteChange?.(null)
      return
    }
    onPanePaletteChange?.({
      paneCounts,
      t4Integration,
      onAdd: addPane,
      onDragStart: (type) => {
        const definition = paneRegistry[type]
        if (definition?.singleton) {
          const existing = findFirstPaneByType(layoutRef.current, type)
          if (existing) { commit(updatePane(layoutRef.current, existing.id, (pane) => pane)); setActivePaneId(existing.id); setPalettePane(null); return }
        }
        const prewarmedOmp = ompPrewarmRef.current && !findPane(layoutRef.current, ompPrewarmRef.current.pane.id) ? ompPrewarmRef.current.pane : null
        setPalettePane(freshPane(type, prewarmedOmp))
      },
      onDragEnd: () => setPalettePane(null),
    })
    return () => onPanePaletteChange?.(null)
  }, [addPane, commit, fullscreenPane, onPanePaletteChange, paneCounts, t4Integration])

  return (
    <div
      className="relative flex h-full min-h-0 overflow-hidden bg-background"
      data-layout-revision={layoutRevisionRef.current}
    >
      {(layoutSaveError || layoutNotice) && (
        <div data-layout-save-notice role="status" className="absolute left-1/2 top-2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
          <span>{layoutSaveError ?? layoutNotice}</span>
          {layoutSaveError && <Button size="sm" variant="outline" onClick={retryLayoutSave}>Retry save</Button>}
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        <LayoutView node={layout} root={layout} lane={lane} terminalBindings={terminalBindings} terminalAttachHint={terminalAttachHint} activePaneId={activePaneId} draggedPaneId={draggedPaneId} palettePane={palettePane}
          t4Integration={t4Integration}
          fullscreenPaneId={fullscreenPaneId} confirmTerminalClose={confirmTerminalClose} terminalTitles={terminalTitles}
          closingPaneId={closingPane?.pane.id ?? null} terminalClosePending={terminalClosePending} skipCloseConfirmation={skipCloseConfirmation} restartingPaneId={restartingPane?.id ?? null}
          onActivate={setActivePaneId} onDrag={setDraggedPaneId} onPaletteDrag={setPalettePane} onChange={commit} onClose={requestClosePane}
          onAddTerminalTab={addTerminalTab} onStartNewTerminalSession={setRestartingPane} onCancelNewTerminalSession={() => setRestartingPane(null)} onConfirmNewTerminalSession={confirmNewTerminalSession} onCancelTerminalClose={() => setClosingPane(null)} onConfirmTerminalClose={confirmClosePane} onSkipCloseConfirmation={setSkipCloseConfirmation} onTerminalTitle={updateTerminalTitle} onTerminalStarted={terminalStarted}
          onToggleFullscreen={setFullscreenPaneId} onSetConfirmTerminalClose={updateTerminalCloseConfirmation}
          onTerminalBinding={acceptTerminalBinding} onTerminalActivity={publishTerminalActivity} onOpenWebPreview={openPreview} onReloadWebPreview={reloadPreview}
          />
      </div>
    </div>
  )
}
function TerminalCloseDialog({ open, pending, skip, onSkipChange, onCancel, onConfirm }: {
  open: boolean; pending: boolean; skip: boolean; onSkipChange: (skip: boolean) => void; onCancel: () => void; onConfirm: () => void
}) {
  return <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next && !pending) onCancel() }}>
    <AlertDialog.Overlay data-terminal-close-overlay className="absolute inset-0 z-40 bg-black/65 backdrop-blur-sm" />
    <AlertDialog.Content className="absolute left-1/2 top-1/2 z-50 max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-2xl">
      <AlertDialog.Title className="text-base font-semibold">Close agent terminal?</AlertDialog.Title>
      <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
        This ends the terminal session and stops any running command. Files in this folder stay safe.
      </AlertDialog.Description>
      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" checked={skip} disabled={pending} onChange={(event) => onSkipChange(event.target.checked)} className="size-4 accent-primary" />
        Don&apos;t ask again in this lane
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel asChild><Button variant="outline" disabled={pending}>Keep terminal</Button></AlertDialog.Cancel>
        <Button variant="destructive" disabled={pending} onClick={onConfirm}>{pending ? "Closing…" : "Close terminal"}</Button>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Root>
}

function TerminalNewSessionDialog({ open, onCancel, onConfirm }: {
  open: boolean; onCancel: () => void; onConfirm: () => void
}) {
  return <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
    <AlertDialog.Overlay data-terminal-new-session-overlay className="absolute inset-0 z-40 bg-black/65 backdrop-blur-sm" />
    <AlertDialog.Content className="absolute left-1/2 top-1/2 z-50 max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-2xl">
      <AlertDialog.Title className="text-base font-semibold">Start a new session?</AlertDialog.Title>
      <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
        This closes the current session and stops any running command. A new session opens in this pane. Files in this folder stay safe.
      </AlertDialog.Description>
      <div className="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel asChild><Button variant="outline">Keep current session</Button></AlertDialog.Cancel>
        <AlertDialog.Action asChild><Button variant="destructive" onClick={onConfirm}>Start new session</Button></AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Root>
}

export function PanePalette({ controller }: { controller: PanePaletteController }) {
  const edition = useDistribution()
  const presentation = edition.surface("pane-palette")
  if (presentation?.visibility === "hidden") return null
  return (
    <section aria-label="Pane palette" data-bento-palette="true" data-operator-engine-slot="pane-palette">
      <div className="px-2 pb-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{presentation?.label ?? "Pane palette"}</div>
      <div className="flex flex-col gap-1.5">
        {Object.values(paneRegistry).filter((definition) => (!definition.distributionId || definition.distributionId === edition.distributionId) && (definition.id !== "t4-code" || controller.t4Integration.url !== null || controller.t4Integration.error !== null)).map((definition) => {
          const count = controller.paneCounts[definition.id] ?? 0
          const panePresentation = definition.id === "t4-code" ? edition.panePresentations?.["t4-code"] : undefined
          return <PaletteCard key={definition.id} definition={definition} presentation={panePresentation} count={count} present={Boolean(definition.singleton && count > 0)} onAdd={controller.onAdd} onDragStart={controller.onDragStart} onDragEnd={controller.onDragEnd} />
        })}
      </div>
      <p className="px-1 py-3 text-[10px] leading-snug text-muted-foreground">{presentation?.description ?? "Click to add beside the active pane. Drag to an edge to split, or to the center to create a tab."}</p>
    </section>
  )
}

function PaletteCard({ definition, presentation, count, present, onAdd, onDragStart, onDragEnd }: { definition: (typeof paneRegistry)[string]; presentation?: { label: string; description: string }; count: number; present: boolean; onAdd: (type: string) => void; onDragStart: (type: string) => void; onDragEnd: () => void }) {
  const Icon = definition.icon
  const label = presentation?.label ?? definition.label
  const description = presentation?.description ?? definition.description
  return <button type="button" draggable={!present} onClick={() => onAdd(definition.id)} onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; onDragStart(definition.id) }} onDragEnd={onDragEnd}
    className={cn("flex items-start gap-2 rounded border border-border bg-background px-2 py-2 text-left hover:border-muted-foreground", present ? "cursor-pointer" : "cursor-grab active:cursor-grabbing")} title={present ? `Show existing ${label}` : `Click or drag to add ${label}`}>
    <GripVertical className="mt-0.5 size-3 shrink-0 text-muted-foreground" /><Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[12px]">{label}</span>{count > 0 ? <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-border bg-accent px-1 text-[9px] font-medium tabular-nums text-muted-foreground" aria-label={`${count} in this lane`}>{count}</span> : null}</span><span className="mt-0.5 block text-[9px] leading-snug text-muted-foreground">{present ? "Already in this lane. Click to show it." : description}</span></span>
  </button>
}

type LayoutViewProps = {
  node: LayoutNode; root: LayoutNode; lane: Lane; terminalBindings: Record<string, TerminalBinding>; terminalAttachHint: number; activePaneId: string; draggedPaneId: string | null; palettePane: PaneNode | null
  t4Integration: T4IntegrationConfig
  fullscreenPaneId: string | null; confirmTerminalClose: boolean; terminalTitles: Readonly<Record<string, string>>; closingPaneId: string | null; terminalClosePending: boolean; skipCloseConfirmation: boolean; restartingPaneId: string | null
  onActivate: (id: string) => void; onDrag: (id: string | null) => void; onPaletteDrag: (pane: PaneNode | null) => void
  onChange: (next: LayoutNode) => void; onClose: (pane: PaneNode) => void; onTerminalBinding: (binding: TerminalBinding) => TerminalBinding | null; onTerminalActivity: (paneId: string, bindingGeneration: number, live: boolean) => void
  onAddTerminalTab: (targetId: string) => void; onStartNewTerminalSession: (pane: PaneNode) => void; onCancelNewTerminalSession: () => void; onConfirmNewTerminalSession: () => void; onCancelTerminalClose: () => void; onConfirmTerminalClose: () => void; onSkipCloseConfirmation: (skip: boolean) => void; onTerminalTitle: (paneId: string, title: string | null) => void; onTerminalStarted: (paneId: string) => void
  onToggleFullscreen: (paneId: string | null) => void; onSetConfirmTerminalClose: (enabled: boolean) => void
  onOpenWebPreview: (location: string, sourcePaneId: string) => void; onReloadWebPreview: (paneId: string) => void
}

function LayoutView(props: LayoutViewProps) {
  const edition = useDistribution()
  if (props.node.kind === "pane") return <PaneView {...props} pane={props.node} />
  if (props.node.kind === "tabs") {
    const tabs = props.node
    const active = tabs.panes.find((pane) => pane.id === tabs.activeId) ?? tabs.panes[0]
    const fullscreenInTabs = Boolean(props.fullscreenPaneId && tabs.panes.some((pane) => pane.id === props.fullscreenPaneId))
    return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="tablist" aria-label="Pane tabs" className={cn("h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-hud-rail px-1", fullscreenInTabs ? "hidden" : "flex")}>
        {tabs.panes.map((pane) => {
          const definition = paneRegistry[pane.pane]
          const panePresentation = pane.pane === "t4-code" ? edition.panePresentations?.["t4-code"] : undefined
          const title = pane.pane === "terminal" ? props.terminalTitles[pane.id] ?? definition?.label : panePresentation?.label ?? definition?.label
          const label = title ?? `Unavailable: ${pane.pane}`
          const selected = pane.id === active.id
          return <div key={pane.id} className={cn("group flex min-w-0 max-w-56 shrink-0 items-center rounded text-[10px]", selected ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent")}>
            <button type="button" role="tab" aria-selected={selected} title={label} onClick={() => { props.onChange(replacePane(props.root, pane.id, pane)); props.onActivate(pane.id) }} className="flex h-6 min-w-0 flex-1 items-center px-2 text-left">
              <span className="truncate">{label}</span>
            </button>
            <button type="button" aria-label={`Close ${label}`} title={`Close ${label}`} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); props.onClose(pane) }} className="grid size-6 shrink-0 place-items-center rounded opacity-0 hover:bg-background/60 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100">
              <X className="size-3" />
            </button>
          </div>
        })}
        <button type="button" aria-label="New agent terminal tab" title="New agent terminal tab" onClick={() => props.onAddTerminalTab(active.id)} className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
          <Plus className="size-3.5" />
        </button>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {tabs.panes.map((pane) => <div key={pane.id} className={cn("min-h-0 min-w-0 flex-1", pane.id === active.id ? "flex" : "hidden")}><PaneView {...props} pane={pane} /></div>)}
      </div>
    </div>
  }
  return <SplitView {...props} split={props.node} />
}

type SharedProps = Omit<LayoutViewProps, "node">

function SplitView(props: SharedProps & { split: SplitNode }) {
  const { split } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const [resizing, setResizing] = useState(false)
  const horizontal = split.direction === "horizontal"
  const fullscreenInFirst = Boolean(props.fullscreenPaneId && findPane(split.first, props.fullscreenPaneId))
  const fullscreenInSecond = Boolean(props.fullscreenPaneId && findPane(split.second, props.fullscreenPaneId))
  const fullscreenInSplit = fullscreenInFirst || fullscreenInSecond
  const resize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    setResizing(true)
    const move = (next: PointerEvent) => {
      const rect = hostRef.current?.getBoundingClientRect(); if (!rect) return
      const percentage = horizontal ? ((next.clientX - rect.left) / rect.width) * 100 : ((next.clientY - rect.top) / rect.height) * 100
      props.onChange(updateSplit(props.root, split, percentage))
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", stop)
      if (handle.isConnected && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      setResizing(false)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("blur", stop)
  }
  return <div ref={hostRef} className={cn("flex min-h-0 min-w-0 flex-1", horizontal ? "flex-row" : "flex-col")}>
    <div className={cn("min-h-0 min-w-0", fullscreenInSecond ? "hidden" : "flex", fullscreenInFirst && "flex-1")} style={fullscreenInFirst ? undefined : { [horizontal ? "width" : "height"]: `${split.percentage}%` }}><LayoutView {...props} node={split.first} /></div>
    <button type="button" onPointerDown={resize} className={cn("z-30 shrink-0 touch-none bg-border hover:bg-muted-foreground", fullscreenInSplit ? "hidden" : horizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize")} aria-label="Resize panes"><GripHorizontal className="hidden" /></button>
    <div className={cn("min-h-0 min-w-0 flex-1", fullscreenInFirst ? "hidden" : "flex")}><LayoutView {...props} node={split.second} /></div>
    {resizing ? <div data-pane-resize-shield aria-hidden="true" className={cn("fixed inset-0 z-[100] touch-none select-none", horizontal ? "cursor-col-resize" : "cursor-row-resize")} /> : null}
  </div>
}

function PaneView(props: SharedProps & { pane: PaneNode }) {
  const { pane } = props
  const definition = paneRegistry[pane.pane]
  const edition = useDistribution()
  const definitionAvailable = Boolean(definition && (!definition.distributionId || definition.distributionId === edition.distributionId))
  const panePresentation = pane.pane === "t4-code" ? edition.panePresentations?.["t4-code"] : undefined
  const [dropZone, setDropZone] = useState<DropZone | null>(null)
  const fullscreen = props.fullscreenPaneId === pane.id
  const multiplePanes = paneIds(props.root).length > 1
  const calculateZone = (event: React.DragEvent): DropZone => {
    const rect = event.currentTarget.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width; const y = (event.clientY - rect.top) / rect.height
    if (x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7) return "center"
    const distances = { left: x, right: 1 - x, top: y, bottom: 1 - y }
    return Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0] as DropZone
  }
  const Icon = definition?.icon ?? Box
  const paneTitle = pane.pane === "terminal" ? props.terminalTitles[pane.id] ?? definition?.label : panePresentation?.label ?? definition?.label
  const renderProps = { lane: props.lane, pane, binding: props.terminalBindings[pane.id] ?? null, terminalAttachHint: props.terminalAttachHint, active: props.activePaneId === pane.id, t4Integration: props.t4Integration, onTerminalBinding: props.onTerminalBinding, onTerminalActivity: props.onTerminalActivity, onTerminalTitle: props.onTerminalTitle, onTerminalStarted: props.onTerminalStarted, onOpenWebPreview: props.onOpenWebPreview, onReloadWebPreview: props.onReloadWebPreview }
  const menuItemClass = "relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-xs outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
  return <section data-pane-id={pane.id} data-pane-fullscreen={fullscreen ? "true" : undefined} data-distribution-onboarding-target={pane.pane === "web-preview" ? "browser" : pane.pane === "terminal" ? "agent-terminal" : undefined} className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-transparent", props.activePaneId === pane.id && "border-ring/40")}
    onMouseDown={() => props.onActivate(pane.id)}
    onDragOver={(event) => { if (props.palettePane || (props.draggedPaneId && props.draggedPaneId !== pane.id)) { event.preventDefault(); event.dataTransfer.dropEffect = props.palettePane ? "copy" : "move"; setDropZone(calculateZone(event)) } }}
    onDragLeave={() => setDropZone(null)}
    onDrop={(event) => { event.preventDefault(); if (props.palettePane && dropZone) { const definition = paneRegistry[props.palettePane.pane]; const existing = definition?.singleton ? findFirstPaneByType(props.root, props.palettePane.pane) : null; if (existing) { props.onChange(updatePane(props.root, existing.id, (candidate) => candidate)); props.onActivate(existing.id) } else { props.onChange(insertPane(props.root, pane.id, props.palettePane, dropZone)); props.onActivate(props.palettePane.id) } } else if (props.draggedPaneId && dropZone) props.onChange(movePane(props.root, props.draggedPaneId, pane.id, dropZone)); props.onDrag(null); props.onPaletteDrag(null); setDropZone(null) }}>
    <header draggable={!fullscreen} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; props.onDrag(pane.id) }} onDragEnd={() => props.onDrag(null)} className={cn("flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-hud-rail px-2", fullscreen ? "cursor-default" : "cursor-grab active:cursor-grabbing")}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" title={paneTitle}>{paneTitle ?? `Pane unavailable: ${pane.pane}`}</span>
      {definition?.renderHeader?.(renderProps)}
      <div className={cn("flex items-center", !definition?.renderHeader && "ml-auto")}>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><Button variant="ghost" size="icon-sm" className="size-6" aria-label={`Open ${definition?.label ?? "pane"} menu`}><MoreHorizontal className="size-3.5" /></Button></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content sideOffset={4} align="end" className="z-50 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
              {multiplePanes ? <DropdownMenu.Item className={menuItemClass} onSelect={() => props.onToggleFullscreen(fullscreen ? null : pane.id)}>
                {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}{fullscreen ? "Exit full screen" : "Full screen"}
              </DropdownMenu.Item> : null}
              {pane.pane === "terminal" ? <>
                {multiplePanes ? <DropdownMenu.Separator className="my-1 h-px bg-border" /> : null}
                <DropdownMenu.Item className={menuItemClass} onSelect={() => props.onStartNewTerminalSession(pane)}>
                  <RotateCcw className="size-3.5" />Start new session
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.CheckboxItem className={menuItemClass} checked={props.confirmTerminalClose} onCheckedChange={(checked) => props.onSetConfirmTerminalClose(checked === true)}>
                  <span className="grid size-3.5 place-items-center"><DropdownMenu.ItemIndicator><Check className="size-3.5" /></DropdownMenu.ItemIndicator></span>
                  Confirm before closing
                </DropdownMenu.CheckboxItem>
              </> : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        {multiplePanes ? <Button variant="ghost" size="icon-sm" className="size-6" onClick={() => props.onClose(pane)} aria-label="Close pane"><X className="size-3" /></Button> : null}
      </div>
    </header>
    <div className="min-h-0 flex-1">{definitionAvailable ? definition!.render(renderProps) : <UnavailablePane type={pane.pane} dormant={Boolean(definition)} />}</div>
    {props.closingPaneId === pane.id ? <TerminalCloseDialog open pending={props.terminalClosePending} skip={props.skipCloseConfirmation} onSkipChange={props.onSkipCloseConfirmation} onCancel={props.onCancelTerminalClose} onConfirm={props.onConfirmTerminalClose} /> : null}
    {props.restartingPaneId === pane.id ? <TerminalNewSessionDialog open onCancel={props.onCancelNewTerminalSession} onConfirm={props.onConfirmNewTerminalSession} /> : null}
    {dropZone ? <DropOverlay zone={dropZone} /> : null}
  </section>
}

function UnavailablePane({ type, dormant = false }: { type: string; dormant?: boolean }) {
  return <div className="grid h-full place-items-center bg-background p-6 text-center"><div className="max-w-sm"><Box className="mx-auto size-6 text-muted-foreground" /><h3 className="mt-3 text-sm font-semibold">{dormant ? "Provider unavailable" : "Pane unavailable"}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{dormant ? "This saved pane is dormant in the current product. Its saved state and files are unchanged." : <>The saved pane type <code>{type}</code> is not included in this build. Close it or install a reviewed release that contains it; the rest of the layout is still usable.</>}</p></div></div>
}

function DropOverlay({ zone }: { zone: DropZone }) {
  const placement = { left: "left-0 top-0 h-full w-1/2", right: "right-0 top-0 h-full w-1/2", top: "left-0 top-0 h-1/2 w-full", bottom: "bottom-0 left-0 h-1/2 w-full", center: "left-1/4 top-1/4 h-1/2 w-1/2 rounded-lg" }[zone]
  return <div className={cn("pointer-events-none absolute z-50 border-2 border-ring bg-accent/50", placement)} />
}
