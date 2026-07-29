"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

import type { EditionState, EditionSurfaceId } from "@/lib/editions"
import type { RuntimeCapabilitiesPublic } from "@/lib/distributions"
import { presentationTerms, type PresentationTerms } from "@/lib/presentation-terms"

type DistributionContextValue = RuntimeCapabilitiesPublic & EditionState & {
  productName: string
  subtitle: string
  productIconUrl?: string
  workItemSingular: PresentationTerms["workItemSingular"]
  workItemPlural: PresentationTerms["workItemPlural"]
  workItemSingularTitle: PresentationTerms["workItemSingularTitle"]
  workItemPluralTitle: PresentationTerms["workItemPluralTitle"]
  surface: (id: EditionSurfaceId) => NonNullable<NonNullable<RuntimeCapabilitiesPublic["edition"]["active"]>["surfaces"]>[EditionSurfaceId]
  refresh: () => Promise<void>
}

const DistributionContext = createContext<DistributionContextValue | null>(null)

export function DistributionProvider({ initial, children }: { initial: RuntimeCapabilitiesPublic; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(initial)
  const active = snapshot.edition.active
  const productName = active?.surfaces?.["product-name"]?.label ?? active?.brand?.productName ?? (snapshot.edition.locked ? "Product unavailable" : "Operator Engine")
  const subtitle = active?.surfaces?.["product-subtitle"]?.label ?? active?.brand?.subtitle ?? "Local client"
  const terms = useMemo(() => presentationTerms(active), [active])
  const refresh = useCallback(async () => {
    const response = await fetch("/api/runtime-capabilities", { cache: "no-store" })
    if (!response.ok) throw new Error("Unable to refresh runtime capabilities.")
    setSnapshot(await response.json() as RuntimeCapabilitiesPublic)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.operatorEngineEdition = active?.id ?? "stock"
    document.documentElement.dataset.distribution = snapshot.distributionId
    document.documentElement.dataset.runtimeRole = snapshot.runtimeIdentity.role
    document.documentElement.dataset.runtimeMode = snapshot.runtimeIdentity.mode
    document.documentElement.dataset.runtimeDataClass = snapshot.runtimeIdentity.dataClass
    document.documentElement.dataset.runtimeWebPort = String(snapshot.runtimeIdentity.webPort)
    document.documentElement.dataset.runtimeTerminalPort = String(snapshot.runtimeIdentity.terminalPort)
    document.documentElement.dataset.runtimeSourceCommit = snapshot.runtimeIdentity.sourceCommit ?? "uncommitted"
    document.documentElement.dataset.runtimeReleaseId = snapshot.runtimeIdentity.releaseId ?? "none"
    document.documentElement.dataset.runtimeContentSha256 = snapshot.runtimeIdentity.contentSha256 ?? "development"
    document.title = productName
    const previous = document.querySelector<HTMLLinkElement>('link[data-operator-engine-edition-favicon]')
    previous?.remove()
    if (active?.brand?.faviconUrl) {
      const link = document.createElement("link")
      link.rel = "icon"
      link.href = active.brand.faviconUrl
      link.dataset.operatorEngineEditionFavicon = "true"
      document.head.append(link)
    }
    return () => {
      for (const attribute of ["data-operator-engine-edition", "data-distribution", "data-runtime-role", "data-runtime-mode", "data-runtime-data-class", "data-runtime-web-port", "data-runtime-terminal-port", "data-runtime-source-commit", "data-runtime-release-id", "data-runtime-content-sha256"]) document.documentElement.removeAttribute(attribute)
      document.querySelector<HTMLLinkElement>('link[data-operator-engine-edition-favicon]')?.remove()
    }
  }, [active?.brand?.faviconUrl, active?.id, productName, snapshot.distributionId, snapshot.runtimeIdentity])

  const value = useMemo<DistributionContextValue>(() => ({
    ...snapshot,
    ...snapshot.edition,
    productName,
    subtitle,
    productIconUrl: active?.surfaces?.["product-mark"]?.iconUrl ?? active?.brand?.iconUrl,
    ...terms,
    surface: (id) => active?.surfaces?.[id],
    refresh,
  }), [active, productName, refresh, snapshot, subtitle, terms])

  if (snapshot.edition.locked && !active) return <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground"><section className="w-full max-w-md text-center"><div className="font-mono text-3xl text-muted-foreground" aria-hidden>›_</div><h1 className="mt-4 text-xl font-semibold">This product could not start</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Its required presentation is unavailable. Your folders and files were not changed.</p><button type="button" className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" onClick={() => window.location.reload()}>Try again</button><details className="mt-5 text-left text-xs text-muted-foreground"><summary className="cursor-pointer text-center">Technical details</summary><p className="mt-2 rounded-md border border-border bg-muted/40 p-3 font-mono">{snapshot.edition.error ?? "The required Edition could not be loaded."}</p></details></section></main>
  return <DistributionContext.Provider value={value}>{children}</DistributionContext.Provider>
}

export function useDistribution(): DistributionContextValue {
  const value = useContext(DistributionContext)
  if (!value) throw new Error("useDistribution must be used inside DistributionProvider.")
  return value
}
