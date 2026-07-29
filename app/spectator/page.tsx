"use client"

import { useState, useEffect } from "react"
import { SpectatorWorkbench } from "@/components/spectator-workbench"
import { DistributionProvider } from "@/components/distribution-provider"
import type { Lane } from "@/lib/types"
import type { RuntimeCapabilitiesPublic } from "@/lib/distributions"

const DEFAULT_CAPABILITIES: RuntimeCapabilitiesPublic = {
  harnesses: [],
  distributionId: "theme-7",
  runtimeIdentity: {
    sourceCommit: null,
    distribution: "theme-7",
    role: "development",
    mode: "standalone",
    webPort: 4300,
    terminalPort: 4301,
    dataClass: "isolated",
    releaseId: null,
    contentSha256: null
  },
  edition: {
    active: null,
    activeId: "theme-7",
    locked: false,
    editions: []
  }
}

export default function SpectatorPage() {
  const [lanes, setLanes] = useState<Lane[]>([
    {
      id: "spectator-lane-1",
      name: "Live Session Lane",
      path: "C:\\workspace\\theme7-demo",
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      layout: null,
      layoutRevision: 0,
      terminalBindings: {},
      recipeId: "blank",
      recipeVersion: 1,
      defaultHarness: "shell",
      threadLinks: []
    }
  ])
  const [capabilities, setCapabilities] = useState<RuntimeCapabilitiesPublic>(DEFAULT_CAPABILITIES)

  useEffect(() => {
    fetch("/api/lanes")
      .then(res => res.json())
      .then(data => {
        if (data && Array.isArray(data.lanes) && data.lanes.length > 0) {
          setLanes(data.lanes)
        }
      })
      .catch(() => {})

    fetch("/api/runtime-capabilities")
      .then(res => res.json())
      .then(data => {
        if (data && data.distributionId) {
          setCapabilities(data)
        }
      })
      .catch(() => {})
  }, [])

  return (
    <DistributionProvider initial={capabilities}>
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-stone-950 text-stone-100 font-sans">
        {/* Spectator Top Banner */}
        <div className="bg-red-900/90 text-red-100 border-b border-red-700 px-4 py-2 text-xs font-bold flex items-center justify-between shadow-md">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-red-400 animate-pulse" />
            <span>🔴 READ-ONLY SPECTATOR BROADCAST</span>
            <span className="text-red-300 font-normal">|</span>
            <span className="font-mono text-red-200">INPUT &amp; OMP MUTATIONS STRICTLY DISABLED</span>
          </div>
          <div className="text-[11px] font-mono text-red-300">
            SESSION REFLECTION MODE
          </div>
        </div>

        {/* Main Spectator Workspace View */}
        <div className="flex-1 overflow-hidden">
          <SpectatorWorkbench 
            lanes={lanes} 
            activeLane={lanes[0]} 
            t4Integration={{ url: null, error: null }} 
          />
        </div>
      </div>
    </DistributionProvider>
  )
}
