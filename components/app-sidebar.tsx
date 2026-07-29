"use client"

import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Monitor, Moon, PanelLeftClose, Settings2, Sun } from "lucide-react"

import { PanePalette, type PanePaletteController } from "@/components/bento-workspace"
import { useDistribution } from "@/components/distribution-provider"
import { Button } from "@/components/ui/button"
import { browserStorageGet, browserStorageSet } from "@/lib/utils"

type Theme = "light" | "dark" | "system"

const THEMES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
}

export function AppSidebar({ open, onClose, panePalette, onWalkthrough }: { open: boolean; onClose: () => void; panePalette: PanePaletteController | null; onWalkthrough?: () => void }) {
  const [theme, setTheme] = useState<Theme>("system")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const edition = useDistribution()

  useEffect(() => {
    const saved = browserStorageGet("operator-engine-theme")
    const initial: Theme = saved === "light" || saved === "dark" || saved === "system" ? saved : "system"
    setTheme(initial)
    applyTheme(initial)
  }, [])

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const update = () => theme === "system" && applyTheme("system")
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [theme])

  const chooseTheme = (next: Theme) => {
    setTheme(next)
    browserStorageSet("operator-engine-theme", next)
    applyTheme(next)
  }

  const walkthrough = edition.surface("onboarding")?.visibility !== "hidden" ? edition.active?.onboarding?.walkthrough : undefined
  const runtime = edition.runtimeIdentity
  const shortCommit = runtime.sourceCommit?.slice(0, 12) ?? "uncommitted"
  const shortContent = runtime.contentSha256?.slice(0, 12) ?? "development"

  return (
    <aside
      className={`min-h-0 shrink-0 overflow-hidden border-r border-border bg-hud-rail transition-[width] duration-200 ease-linear ${open ? "w-80" : "w-0 border-r-0"}`}
      aria-hidden={!open}
    >
      <div className="flex h-full w-80 flex-col [--sidebar:var(--hud-rail)]">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <div className="min-w-0 flex-1 leading-none">
            {edition.surface("product-name")?.visibility === "hidden" ? null : <div data-operator-engine-slot="product-name" className="truncate text-sm font-semibold">{edition.productName}</div>}
            {edition.surface("product-subtitle")?.visibility === "hidden" ? null : <div data-operator-engine-slot="product-subtitle" className="mt-1 truncate text-xs text-muted-foreground">{edition.subtitle}</div>}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={`Close ${edition.productName} sidebar`}>
            <PanelLeftClose className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {panePalette ? <PanePalette controller={panePalette} /> : null}
          {onWalkthrough && walkthrough ? <button type="button" onClick={onWalkthrough} className="mt-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"><span>◫</span> {walkthrough.replayLabel}</button> : null}

          <div className="mt-2 border-t border-border pt-3">
            <button
              type="button"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((current) => !current)}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-accent"
            >
              <Settings2 className="size-4 text-muted-foreground" />
              Settings
              {settingsOpen ? <ChevronDown className="ml-auto size-4 text-muted-foreground" /> : <ChevronRight className="ml-auto size-4 text-muted-foreground" />}
            </button>
          </div>

          {settingsOpen ? <div className="pb-3 pl-2">
            <div className="px-2 pb-2 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Appearance</div>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-background/60 p-1">
              {THEMES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => chooseTheme(value)}
                  aria-pressed={theme === value}
                  className={`flex h-16 flex-col items-center justify-center gap-1.5 rounded-md text-[10px] transition-colors ${theme === value ? "bg-accent text-accent-foreground shadow-sm" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </div>

            <details className="mt-3 border-t border-border pt-2">
              <summary className="cursor-pointer px-2 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Runtime</summary>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 pb-2 text-xs">
                <dt className="text-muted-foreground">Commit</dt><dd className="truncate font-mono">{shortCommit}</dd>
                <dt className="text-muted-foreground">Application</dt><dd>Theme7</dd>
                <dt className="text-muted-foreground">Profile</dt><dd>{runtime.role} / {runtime.mode}</dd>
                <dt className="text-muted-foreground">Ports</dt><dd className="font-mono">{runtime.webPort} / {runtime.terminalPort}</dd>
                <dt className="text-muted-foreground">Data</dt><dd>{runtime.dataClass}</dd>
                <dt className="text-muted-foreground">Release</dt><dd className="truncate font-mono">{runtime.releaseId ?? "none"}</dd>
                <dt className="text-muted-foreground">Content</dt><dd className="truncate font-mono">{shortContent}</dd>
              </dl>
            </details>

          </div> : null}
        </div>
      </div>
    </aside>
  )
}
