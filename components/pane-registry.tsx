"use client"

import type { ComponentType, ReactNode } from "react"
import { Files, Globe2, MessageSquareText, TerminalSquare } from "lucide-react"

import { FilesPane } from "@/components/files-pane"
import { TerminalPane } from "@/components/terminal-pane"
import { T4CodePane } from "@/components/t4-code-pane"
import { WebPreviewPane } from "@/components/web-preview-pane"
import { terminalPane, webPreviewPane, type PaneNode } from "@/lib/bento-layout"
import type { DistributionId } from "@/lib/distributions"
import type { Lane, T4IntegrationConfig, TerminalBinding } from "@/lib/types"

export type PaneCreateContext = { role: "first" | "additional" }
export type PaneRenderProps = {
  lane: Lane
  pane: PaneNode
  binding: TerminalBinding | null
  terminalAttachHint: number
  active: boolean
  t4Integration: T4IntegrationConfig
  onTerminalBinding: (binding: TerminalBinding) => TerminalBinding | null
  onTerminalActivity: (paneId: string, bindingGeneration: number, live: boolean) => void
  onTerminalTitle: (paneId: string, title: string | null) => void
  onTerminalStarted: (paneId: string) => void
  onOpenWebPreview: (location: string, sourcePaneId: string) => void
  onReloadWebPreview: (paneId: string) => void
}
export type PaneDefinition = {
  id: string
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
  singleton?: boolean
  distributionId?: DistributionId
  create(context: PaneCreateContext): PaneNode
  render(props: PaneRenderProps): ReactNode
  renderHeader?(props: PaneRenderProps): ReactNode
}

export const paneRegistry: Record<string, PaneDefinition> = {
  terminal: {
    id: "terminal",
    label: "Agent terminal",
    description: "Start an agent or native shell in this folder.",
    icon: TerminalSquare,
    create: ({ role }) => terminalPane(`terminal-${crypto.randomUUID()}`, role),
    render: ({ lane, pane, binding, terminalAttachHint, active, onTerminalBinding, onTerminalActivity, onTerminalTitle, onTerminalStarted }) => <TerminalPane lane={lane} pane={pane} binding={binding} attachHint={terminalAttachHint} active={active} onTerminalBinding={onTerminalBinding} onTerminalActivity={onTerminalActivity} onSessionTitle={onTerminalTitle} onSessionStarted={onTerminalStarted} />,
  },
  files: {
    id: "files",
    label: "Files",
    description: "Browse the ordinary files and Git state in this lane.",
    icon: Files,
    create: () => ({ kind: "pane", id: `files-${crypto.randomUUID()}`, pane: "files" }),
    render: ({ lane, pane, onOpenWebPreview }) => <FilesPane laneId={lane.id} paneId={pane.id} onOpenWebPreview={onOpenWebPreview} />,
  },
  "t4-code": {
    id: "t4-code",
    label: "Graphical agent",
    description: "Open the reviewed graphical agent interface.",
    icon: MessageSquareText,
    distributionId: "theme-7",
    create: () => ({ kind: "pane", id: `t4-code-${crypto.randomUUID()}`, pane: "t4-code" }),
    render: ({ t4Integration }) => <T4CodePane integration={t4Integration} />,
  },
  "web-preview": {
    id: "web-preview",
    label: "Browser",
    description: "Open lane HTML or an HTTP(S) URL in an iframe.",
    icon: Globe2,
    singleton: true,
    create: () => webPreviewPane(`web-preview-${crypto.randomUUID()}`),
    render: ({ lane, pane, onOpenWebPreview, onReloadWebPreview }) => <WebPreviewPane laneId={lane.id} pane={pane} onNavigate={onOpenWebPreview} onReload={() => onReloadWebPreview(pane.id)} />,
  },
}
