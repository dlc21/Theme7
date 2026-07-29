export type ThreadMessage = {
  role: "user" | "assistant" | "system"
  content: string
  timestampMs: number | null
}

export type ThreadLink = {
  id: string
  sourceSessionId: string
  provider: "omp"
  title: string
  updatedAt: string
  importedAt: string
  messageCount: number
  messages?: ThreadMessage[]
}

export type Lane = {
  id: string
  name: string
  path: string
  createdAt: string
  lastOpenedAt: string
  layout: SavedLayoutV1 | null
  layoutRevision: number
  terminalBindings: Record<string, TerminalBinding>
  recipeId: string | null
  recipeVersion: number | null
  defaultHarness: HarnessId
  threadLinks?: ThreadLink[]
}
export type GitLaneSnapshot = {
  state: "repository" | "plain-directory" | "unavailable"
  branch?: string
  changedFiles: Array<{ path: string; status: string }>
  commits: Array<{ hash: string; shortHash: string; timestamp: string; subject: string }>
  worktrees: Array<{ path: string; branch?: string; head?: string; bare?: boolean; detached?: boolean }>
  reason?: string
}

export type HarnessId = "omp" | "codex" | "shell"

export type TerminalBinding = {
  paneId: string
  harnessId: HarnessId
  resumeSessionId: string | null
  kickoffSent: boolean
  generation: number
  updatedAt: string
}

export type LaneLayoutState = {
  layout: SavedLayoutV1 | null
  layoutRevision: number
  terminalBindings: Record<string, TerminalBinding>
}

export type TerminalTicketRequest =
  | { laneId: string; paneId: string; action: "attach" }
  | { laneId: string; paneId: string; action: "start"; harnessId: HarnessId; expectedGeneration: number; useGuidance?: boolean }
  | { laneId: string; paneId: string; action: "new-session"; harnessId: HarnessId; expectedGeneration: number }
  | { laneId: string; paneId: string; action: "resume-bound"; expectedGeneration: number }
  | { laneId: string; paneId: string; action: "choose-omp-session"; expectedGeneration: number }

export type HarnessAvailabilityState = "available" | "missing" | "broken"

export type HarnessAvailability = {
  id: HarnessId
  label: string
  supportsGuidance: boolean
  state: HarnessAvailabilityState
  version?: string
  help?: string
}

export type TerminalPaneConfig = {
  role: "first" | "additional"
}

export type WebPreviewPaneConfigV1 = {
  location: string | null
  revision: number
}

export type T4IntegrationConfig =
  | { url: string; error: null }
  | { url: null; error: string | null }

export type SavedLayoutV1 = {
  schemaVersion: 1
  tree: import("@/lib/bento-layout").LayoutNode
}

export type DirectoryEntry = {
  name: string
  relativePath: string
  kind: "file" | "directory"
}

export type FileNode = {
  name: string
  relativePath: string
  kind: "file" | "directory"
  children?: FileNode[]
}
