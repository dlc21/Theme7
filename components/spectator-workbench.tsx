"use client"

import { BentoWorkspace } from "@/components/bento-workspace"
import type { Lane, T4IntegrationConfig } from "@/lib/types"
import { Eye, Lock } from "lucide-react"

interface SpectatorWorkbenchProps {
  lanes: Lane[]
  activeLane?: Lane
  t4Integration: T4IntegrationConfig
}

export function SpectatorWorkbench({ activeLane, t4Integration }: SpectatorWorkbenchProps) {
  if (!activeLane) {
    return (
      <div className="grid h-full place-items-center bg-stone-950 text-stone-400">
        <div className="text-center">
          <Eye className="size-8 mx-auto mb-2 text-red-400 animate-pulse" />
          <p className="text-sm font-semibold">Waiting for active operator lane...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex flex-col h-full w-full overflow-hidden bg-stone-950">
      {/* 1-to-1 Bento Workspace Mirror */}
      <div className="flex-1 min-h-0 pointer-events-none select-none">
        <BentoWorkspace lane={activeLane} t4Integration={t4Integration} />
      </div>

      {/* Spectator Lockout Banner Overlay */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full border border-red-800/80 bg-stone-950/90 text-red-300 text-xs font-mono font-semibold shadow-2xl flex items-center gap-2 backdrop-blur-sm">
        <Lock className="size-3.5 text-red-400" />
        <span>READ-ONLY SPECTATOR MIRROR &mdash; INPUT &amp; MUTATIONS DISABLED</span>
      </div>
    </div>
  )
}
