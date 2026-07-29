"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Home, Menu, Plus, Settings2, Sparkles } from "lucide-react"
import { useRouter } from "next/navigation"

import { BentoWorkspace, type PanePaletteController } from "@/components/bento-workspace"
import { AppSidebar } from "@/components/app-sidebar"
import { DirectoryPicker } from "@/components/directory-picker"
import { DistributionOnboarding } from "@/components/distribution-onboarding"
import { EditionWalkthrough } from "@/components/edition-walkthrough"
import { useDistribution } from "@/components/distribution-provider"
import { LaneSettings } from "@/components/lane-settings"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { readJsonResponse } from "@/lib/http-client"
import type { Lane, T4IntegrationConfig } from "@/lib/types"
import { browserStorageGet, browserStorageSet, cn } from "@/lib/utils"

const LANE_EMOJIS = ["🧭", "🎯", "🔭", "💡", "🧠", "🛠️", "⚙️", "🧪", "🚀", "📚", "📡", "🌱"]

function laneEmoji(lane: Lane) {
  let hash = 0
  for (const character of lane.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return LANE_EMOJIS[hash % LANE_EMOJIS.length]
}

function displayLanePath(lane: Lane) {
  const parts = lane.path.replace(/\\/g, "/").split("/").filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/")
}

type DistributionProgress = { stepId: string; laneId?: string; showpieceLocation?: string; completed: boolean }

function CreateLaneButton({ onCreate, position, tourTarget = false }: { onCreate: () => void; position: "list" | "rail"; tourTarget?: boolean }) {
  const { workItemSingular } = useDistribution()
  const action = `Add ${workItemSingular}`
  return <Tooltip><TooltipTrigger asChild><Button type="button" variant="outline" size="icon" data-lane-create-position={position} data-distribution-onboarding-target={tourTarget ? "create-lane" : undefined} className="size-10 min-h-10 shrink-0 rounded-lg bg-background" onClick={onCreate} aria-label={action}><Plus className="size-4" /></Button></TooltipTrigger><TooltipContent side="right">{action}</TooltipContent></Tooltip>
}

export function Workbench({ initialLanes, initialSelectedLaneId, t4Integration }: { initialLanes: Lane[]; initialSelectedLaneId: string; t4Integration: T4IntegrationConfig }) {
  const edition = useDistribution()
  const router = useRouter()
  const [lanes, setLanes] = useState(initialLanes)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [appSidebarOpen, setAppSidebarOpen] = useState(false)
  const [walkthroughOpen, setWalkthroughOpen] = useState(false)
  const [laneSettingsOpen, setLaneSettingsOpen] = useState(false)
  const [panePalette, setPanePalette] = useState<PanePaletteController | null>(null)
  const walkthroughAutoOpenKey = useRef("")
  const distributionStorageKey = edition.onboarding ? `operator-engine:distribution-onboarding:v2:${edition.distributionId}:${edition.onboarding.version}` : ""
  const [distributionIntro, setDistributionIntro] = useState(false)
  const [distributionStepId, setDistributionStepId] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
    if (!edition.onboarding) return
    try {
      const raw = localStorage.getItem(distributionStorageKey)
      const progress = JSON.parse(raw ?? "null") as DistributionProgress | null
      if (progress?.completed) return
      if (progress?.stepId) setDistributionStepId(progress.stepId)
    } catch {}
  }, [distributionStorageKey, edition.onboarding])
  const [previewRequest, setPreviewRequest] = useState<{ token: number; location: string } | undefined>()
  const [previewUnavailable, setPreviewUnavailable] = useState(false)
  const [selectedLaneId, setSelectedLaneId] = useState(initialSelectedLaneId)
  const selectedLane = lanes.find((lane) => lane.id === selectedLaneId) ?? null
  const walkthrough = edition.surface("onboarding")?.visibility !== "hidden" ? edition.active?.onboarding?.walkthrough : undefined
  useEffect(() => {
    setLanes(initialLanes)
    setSelectedLaneId(initialSelectedLaneId)
  }, [initialLanes, initialSelectedLaneId])
  useEffect(() => {
    const syncSelectionFromHistory = () => {
      const match = /^\/lanes\/([^/]+)$/.exec(window.location.pathname)
      let laneId = ""
      try {
        laneId = match ? decodeURIComponent(match[1]) : ""
      } catch {}
      if (!laneId || lanes.some((lane) => lane.id === laneId)) setSelectedLaneId(laneId)
    }
    window.addEventListener("popstate", syncSelectionFromHistory)
    return () => window.removeEventListener("popstate", syncSelectionFromHistory)
  }, [lanes])
  useEffect(() => {
    if (!walkthrough || !edition.active) return
    const key = `operator-engine:onboarding-walkthrough-dismissed:v1:${edition.active.id}:${walkthrough.version}`
    if (walkthroughAutoOpenKey.current === key) return
    walkthroughAutoOpenKey.current = key
    if (browserStorageGet(key) !== null) return
    browserStorageSet(key, "1")
    setPickerOpen(false)
    setWalkthroughOpen(true)
  }, [edition.active, walkthrough])
  // Initial state calculated synchronously above to eliminate layout pop
  const saveDistributionProgress = useCallback((progress: DistributionProgress) => {
    try {
      const current = JSON.parse(browserStorageGet(distributionStorageKey) ?? "{}") as Partial<DistributionProgress>
      browserStorageSet(distributionStorageKey, JSON.stringify({ ...current, ...progress }))
    } catch {}
  }, [distributionStorageKey])
  useEffect(() => {
    let progress: DistributionProgress | null = null
    try { progress = JSON.parse(browserStorageGet(distributionStorageKey) ?? "null") as DistributionProgress | null } catch {}
    if (progress?.showpieceLocation) {
      setPreviewUnavailable(false)
      setPreviewRequest((current) => current ?? { token: Date.now(), location: progress.showpieceLocation! })
    } else {
      setPreviewUnavailable(true)
    }
  }, [distributionStepId, distributionStorageKey])
  useEffect(() => {
    if (distributionStepId === "one-job-one-folder" && !pickerOpen && lanes.length === 0) {
      setPickerOpen(true)
    }
  }, [distributionStepId, pickerOpen, lanes.length])
  const openPicker = () => {
    setWalkthroughOpen(false)
    if (distributionStepId === "got-a-job") { setDistributionStepId("one-job-one-folder"); saveDistributionProgress({ stepId: "one-job-one-folder", completed: false }) }
    setPickerOpen(true)
  }
  const openWalkthrough = () => {
    setPickerOpen(false)
    setAppSidebarOpen(false)
    setWalkthroughOpen(true)
  }
  const onLaneUpdated = (updated: Lane) => {
    setLanes((current) => current.map((lane) => lane.id === updated.id ? updated : lane))
  }
  const updatePanePalette = useCallback((controller: PanePaletteController | null) => setPanePalette(controller), [])



  const openLane = (laneId: string) => {
    if (laneId === selectedLaneId) return
    setSelectedLaneId(laneId)
    window.history.pushState(null, "", `/lanes/${encodeURIComponent(laneId)}`)
  }

  const deleteLane = async (lane: Lane) => {
    if (!window.confirm(`Remove “${lane.name}” from ${edition.productName}? Its files will not be deleted.`)) return
    try {
      const response = await fetch(`/api/lanes/${lane.id}`, { method: "DELETE" })
      await readJsonResponse(response, `The ${edition.workItemSingular} could not be removed. Its files were not changed.`)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : `The ${edition.workItemSingular} could not be removed. Its files were not changed.`)
      return
    }
    const next = lanes.filter((candidate) => candidate.id !== lane.id)
    setLanes(next)
    router.replace(next[0] ? `/lanes/${encodeURIComponent(next[0].id)}` : "/")
  }

  const advanceDistribution = () => {
    if (distributionStepId === "give-the-job-an-agent") { setDistributionStepId("make-the-work-visible"); saveDistributionProgress({ stepId: "make-the-work-visible", laneId: selectedLane?.id, completed: false }); return }
    if (distributionStepId === "make-the-work-visible") {
      if (previewUnavailable || previewRequest === undefined) {
        saveDistributionProgress({ stepId: "make-the-work-visible", laneId: selectedLane?.id, completed: true })
        setDistributionStepId(null)
      }
      return
    }
    if (distributionStepId === "this-is-the-browser") { saveDistributionProgress({ stepId: "this-is-the-browser", laneId: selectedLane?.id, completed: true }); setDistributionStepId(null) }
  }
  const skipDistribution = () => {
    saveDistributionProgress({ stepId: distributionStepId ?? "intro", laneId: selectedLane?.id, completed: true })
    setDistributionIntro(false)
    setDistributionStepId(null)
  }
  return <TooltipProvider>
    <main className="flex h-svh min-h-0 overflow-hidden bg-hud-surface text-foreground">
      <aside data-operator-engine-walkthrough-target="job-list" className="flex w-14 shrink-0 flex-col items-center overflow-y-auto border-r border-border bg-hud-lane-rail px-1.5 py-2">
        {edition.surface("product-mark")?.visibility === "hidden" ? null : <Tooltip><TooltipTrigger asChild><button type="button" data-operator-engine-slot="product-mark" data-operator-engine-walkthrough-fallback="operator" className="mb-2 flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary text-primary-foreground shadow-sm" aria-label={edition.productName}>{edition.productIconUrl ? <img src={edition.productIconUrl} alt="" className="size-10 object-cover" /> : <Sparkles className="size-4" />}</button></TooltipTrigger><TooltipContent side="right">{edition.productName}</TooltipContent></Tooltip>}
        <div className="mb-2 h-px w-8 shrink-0 bg-stone-300/80 dark:bg-stone-700/80" />
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">{lanes.length === 0 ? <div className="px-1 pt-2 text-center text-[9px] leading-tight text-muted-foreground">No {edition.workItemPlural} yet</div> : lanes.map((lane) => {
          const active = lane.id === selectedLaneId
          return <Tooltip key={lane.id}><TooltipTrigger asChild><button type="button" onClick={() => openLane(lane.id)} className={cn("relative flex size-10 min-h-10 shrink-0 items-center justify-center rounded-lg transition-colors", active ? "bg-stone-300 text-stone-950 ring-1 ring-stone-400 dark:bg-stone-700 dark:text-stone-50 dark:ring-stone-600" : "bg-stone-200/60 text-stone-600 opacity-65 hover:bg-stone-200 hover:opacity-100 dark:bg-stone-900 dark:text-stone-400 dark:hover:bg-stone-800")} aria-label={`Select ${edition.workItemSingular} ${lane.name}`}><span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center text-lg leading-6">{laneEmoji(lane)}</span></button></TooltipTrigger><TooltipContent side="right"><div className="font-medium">{lane.name}</div><div className="mt-0.5 max-w-56 truncate text-[10px] opacity-75">{displayLanePath(lane)}</div></TooltipContent></Tooltip>
        })}<CreateLaneButton position="list" tourTarget onCreate={openPicker} /></div>
        <div className="mt-2 shrink-0"><CreateLaneButton position="rail" onCreate={openPicker} /></div>
      </aside>

      <AppSidebar open={appSidebarOpen} onClose={() => setAppSidebarOpen(false)} panePalette={panePalette} onWalkthrough={walkthrough ? openWalkthrough : undefined} />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={() => setAppSidebarOpen((open) => !open)} aria-label={appSidebarOpen ? "Close application sidebar" : "Open application sidebar"}><Menu className="size-4" /></Button></TooltipTrigger><TooltipContent side="bottom" align="start">{appSidebarOpen ? "Close sidebar" : "Open sidebar"}</TooltipContent></Tooltip>
          <div className="flex h-8 min-w-0 max-w-56 flex-col justify-center rounded-sm px-2"><Home className="size-3 text-stone-400 dark:text-stone-500" aria-hidden />{edition.surface("product-name")?.visibility === "hidden" ? null : <span data-operator-engine-slot="product-name" className="mt-0.5 truncate text-[12px] font-medium text-stone-700 dark:text-stone-200">{edition.productName}</span>}</div>
          <div className="flex h-8 min-w-0 flex-1 flex-col justify-center rounded-sm px-2"><span className="text-[8.5px] font-semibold uppercase leading-none tracking-wide text-stone-400 dark:text-stone-500">{edition.workItemSingularTitle}</span><span className="mt-0.5 truncate text-[12px] font-medium text-stone-700 dark:text-stone-200">{selectedLane ? `${laneEmoji(selectedLane)} ${selectedLane.name}` : "Choose a folder to begin"}</span></div>
          {selectedLane ? <><code className="hidden max-w-[38vw] truncate text-[10px] text-muted-foreground lg:block">{displayLanePath(selectedLane)}</code><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={() => setLaneSettingsOpen(true)} aria-label={`Open ${edition.workItemSingular} settings`}><Settings2 className="size-4" /></Button></TooltipTrigger><TooltipContent side="bottom" align="end">{edition.workItemSingularTitle} settings</TooltipContent></Tooltip></> : null}
        </header>
        <div className="min-h-0 flex-1">{selectedLane ? <BentoWorkspace key={selectedLane.id} lane={selectedLane} t4Integration={t4Integration} onPanePaletteChange={updatePanePalette} onTerminalStarted={() => { if (distributionStepId === "give-the-job-an-agent") advanceDistribution() }} previewRequest={previewRequest} onPreviewRequestHandled={(token, result) => { if (previewRequest?.token !== token) return; setPreviewRequest(undefined); if (result === "opened") { setPreviewUnavailable(false); setDistributionStepId("this-is-the-browser"); saveDistributionProgress({ stepId: "this-is-the-browser", laneId: selectedLane.id, showpieceLocation: previewRequest.location, completed: false }) } else setPreviewUnavailable(true) }} /> : <Onboarding onCreate={openPicker} onWalkthrough={walkthrough ? openWalkthrough : undefined} walkthroughLabel={walkthrough?.entryLabel} stepId={distributionStepId} />}</div>
      </section>
      {pickerOpen ? <DirectoryPicker onClose={() => setPickerOpen(false)} starterId={distributionStepId === "one-job-one-folder" ? "browser-showpiece" : undefined} onCreated={(lane, starter) => { setLanes((current) => [lane, ...current]); setPickerOpen(false); if (distributionStepId === "one-job-one-folder") { setDistributionStepId("give-the-job-an-agent"); saveDistributionProgress({ stepId: "give-the-job-an-agent", laneId: lane.id, showpieceLocation: starter?.entry, completed: false }) } openLane(lane.id) }} /> : null}
      {mounted && edition.onboarding && (distributionIntro || distributionStepId) ? <DistributionOnboarding onboarding={edition.onboarding} intro={distributionIntro} stepId={distributionStepId} unavailable={previewUnavailable && (distributionStepId === "make-the-work-visible" || distributionStepId === "this-is-the-browser")} busy={distributionStepId === "make-the-work-visible" && previewRequest !== undefined && !previewUnavailable} onIntroAction={() => { setDistributionIntro(false); setDistributionStepId("got-a-job"); saveDistributionProgress({ stepId: "got-a-job", completed: false }) }} onAdvance={advanceDistribution} onSkip={skipDistribution} /> : null}
      {laneSettingsOpen && selectedLane ? <LaneSettings lane={selectedLane} onClose={() => setLaneSettingsOpen(false)} onUpdated={onLaneUpdated} onRemove={deleteLane} /> : null}
      {walkthroughOpen && walkthrough ? <EditionWalkthrough walkthrough={walkthrough} hasLanes={lanes.length > 0} onClose={() => { setWalkthroughOpen(false); setAppSidebarOpen(false) }} onChooseFolder={openPicker} /> : null}
    </main>
  </TooltipProvider>
}

function Onboarding({ onCreate, onWalkthrough, walkthroughLabel, stepId }: { onCreate: () => void; onWalkthrough?: () => void; walkthroughLabel?: string; stepId?: string | null }) {
  const edition = useDistribution()
  const surface = edition.surface("onboarding")
  return <div data-operator-engine-slot="onboarding" className="grid h-full place-items-center overflow-y-auto bg-background px-6 py-8 text-center"><div className="w-full max-w-2xl">
    {surface?.visibility === "hidden" ? null : <>{edition.active?.onboarding?.videoUrl ? <video className="mb-6 w-full rounded-2xl border border-border shadow-xl" src={edition.active.onboarding.videoUrl} controls muted playsInline /> : edition.active?.onboarding?.imageUrl ? <img className="mb-6 w-full rounded-2xl border border-border shadow-xl" src={edition.active.onboarding.imageUrl} alt="" /> : <div className="font-mono text-3xl text-muted-foreground">›_</div>}
    <h1 className="mt-3 text-xl font-semibold">{surface?.label ?? "Choose a folder"}</h1>
    <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">{surface?.description ?? "Your files stay where they are."}</p></>}
    {onWalkthrough && walkthroughLabel ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2"><Button onClick={onWalkthrough}>{walkthroughLabel}</Button><Button variant="outline" onClick={onCreate}>Add your first job</Button></div> : <Button className="mt-5" data-distribution-onboarding-target={stepId === "got-a-job" ? "create-lane" : undefined} onClick={onCreate}>Choose folder</Button>}
  </div></div>
}
