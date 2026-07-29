import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { detectHarnesses } from "../scripts/harness-adapters.mjs"
import { runtimeIdentityFromEnvironment } from "../scripts/runtime-identity-policy.mjs"
import { t4IntegrationConfig } from "@/lib/config"
import { isPathInside } from "@/lib/path-containment"
import { declaredEditionAssets, editionAssetPayload, editionState, publicEditionFromManifest, validateEditionManifest } from "@/lib/editions"
import { orderHarnesses } from "@/lib/harness-policy"
import { loadTheme7Distribution } from "@/lib/theme-7-loader"
import type { EditionManifestV1, EditionState } from "@/lib/editions"
import type { HarnessAvailability, HarnessId } from "@/lib/types"

export type DistributionId = "stock" | "theme-7"
export type DistributionStarter = { id: "browser-showpiece"; directoryBase: "omp-tour"; entry: "index.html" }
export type GuidedOnboardingTarget = "create-lane" | "directory-picker" | "agent-terminal" | "pane-palette" | "browser"
export type GuidedOnboardingStep = { id: string; target: GuidedOnboardingTarget; secondaryTarget?: GuidedOnboardingTarget; title: string; description: string; descriptionWhenT4?: string; advance: "target-action" | "button"; onEnter?: "open-browser-showpiece" }
export type DistributionPaneId = "t4-code"
export type DistributionPanePresentation = { label: string; description: string }
export type ReviewedDistribution = { id: DistributionId; edition: EditionManifestV1; providerIds: HarnessId[]; panes?: Partial<Record<DistributionPaneId, DistributionPanePresentation>>; starter?: DistributionStarter; onboarding?: { version: string; intro: { title: string; lines: string[]; actionLabel: string }; steps: GuidedOnboardingStep[] } }
export type ReviewedDistributionResources = { packageRoot: URL; editionRoot: URL; starters: Record<"browser-showpiece", URL>; identityExtension?: URL }
export type ReviewedDistributionPackage = { distribution: ReviewedDistribution; resources: ReviewedDistributionResources }
export type GuidedOnboardingPublic = NonNullable<ReviewedDistribution["onboarding"]>
export type RuntimeIdentityPublic = {
  sourceCommit: string | null
  distribution: DistributionId
  role: "development" | "candidate" | "promoted"
  mode: "hmr" | "standalone"
  webPort: number
  terminalPort: number
  dataClass: "isolated" | "durable"
  releaseId: string | null
  contentSha256: string | null
}
export type RuntimeCapabilitiesPublic = { harnesses: HarnessAvailability[]; distributionId: DistributionId; runtimeIdentity: RuntimeIdentityPublic; edition: EditionState; panePresentations?: Partial<Record<DistributionPaneId, DistributionPanePresentation>>; onboarding?: GuidedOnboardingPublic }

const TARGETS = new Set<GuidedOnboardingTarget>(["create-lane", "directory-picker", "agent-terminal", "pane-palette", "browser"])
const ACTIONS = new Set(["target-action", "button"])
const ON_ENTER = new Set(["open-browser-showpiece"])
const PROVIDERS = new Set<HarnessId>(["omp", "codex", "shell"])

export function runtimeIdentity(distribution: DistributionId): RuntimeIdentityPublic {
  return runtimeIdentityFromEnvironment(distribution)
}



export async function validateReviewedDistribution(value: ReviewedDistributionPackage): Promise<ReviewedDistributionPackage> {
  const distribution = value.distribution
  if (distribution.id !== "theme-7" || distribution.edition.id !== distribution.id) throw new Error("Reviewed Distribution identity is invalid.")
  validateEditionManifest(distribution.edition)
  if (new Set(distribution.providerIds).size !== distribution.providerIds.length || distribution.providerIds.some((id) => !PROVIDERS.has(id))) throw new Error("Reviewed Distribution provider ids are invalid.")
  if (distribution.starter && (distribution.starter.id !== "browser-showpiece" || path.isAbsolute(distribution.starter.directoryBase) || path.isAbsolute(distribution.starter.entry) || [distribution.starter.directoryBase, distribution.starter.entry].some((item) => item.split(/[\\/]/).includes("..")))) throw new Error("Reviewed Distribution starter is invalid.")
  const steps = distribution.onboarding?.steps ?? []
  if (steps.length > 5 || new Set(steps.map((step) => step.id)).size !== steps.length || steps.some((step) => !TARGETS.has(step.target) || (step.secondaryTarget && !TARGETS.has(step.secondaryTarget)) || !ACTIONS.has(step.advance) || (step.onEnter && !ON_ENTER.has(step.onEnter)))) throw new Error("Reviewed Distribution onboarding is invalid.")
  const root = await fs.realpath(fileURLToPath(value.resources.packageRoot))
  for (const url of [value.resources.editionRoot, ...Object.values(value.resources.starters), value.resources.identityExtension].filter((item): item is URL => Boolean(item))) {
    const real = await fs.realpath(fileURLToPath(url))
    if (!isPathInside(root, real)) throw new Error("Reviewed Distribution resource escapes its package.")
  }
  return value
}


export async function activeReviewedDistribution(): Promise<ReviewedDistributionPackage | null> {
  const distribution = await loadTheme7Distribution({ required: true })
  return validateReviewedDistribution(distribution)
}

export async function runtimeCapabilities(): Promise<RuntimeCapabilitiesPublic> {
  const detected: HarnessAvailability[] = await detectHarnesses()
  const reviewed = await activeReviewedDistribution()
  const distributionId: DistributionId = "theme-7"
  const harnesses = orderHarnesses(detected, distributionId)
  const local = await editionState()
  if (!reviewed) return { harnesses, distributionId, runtimeIdentity: runtimeIdentity(distributionId), edition: local }
  const baseline = publicEditionFromManifest(reviewed.distribution.edition, "builtin")
  const edition: EditionState = local.active ? local : { ...local, active: baseline, activeId: reviewed.distribution.id, lastEditionId: reviewed.distribution.id, error: undefined }
  const t4 = t4IntegrationConfig()
  const onboarding = reviewed.distribution.onboarding ? { ...reviewed.distribution.onboarding, steps: reviewed.distribution.onboarding.steps.map((step) => t4.url ? { ...step, description: step.descriptionWhenT4 ?? step.description } : { ...step, secondaryTarget: undefined, descriptionWhenT4: undefined }) } : undefined
  return { harnesses, distributionId, runtimeIdentity: runtimeIdentity(distributionId), edition, ...(reviewed.distribution.panes ? { panePresentations: reviewed.distribution.panes } : {}), ...(onboarding ? { onboarding } : {}) }
}

export async function reviewedResourceRoot(): Promise<string | null> {
  const reviewed = await activeReviewedDistribution()
  return reviewed ? fileURLToPath(reviewed.resources.editionRoot) : null
}

export async function activeDistributionAsset(relativeRequest: string): Promise<{ bytes: Buffer; mime: string; etag: string } | null> {
  const reviewed = await activeReviewedDistribution()
  if (!reviewed) return null
  const local = await editionState()
  if (local.active && local.active.id !== reviewed.distribution.id) return null
  const manifest = reviewed.distribution.edition
  const relative = relativeRequest === "theme.css" ? manifest.stylesheet : relativeRequest
  if (!relative || !declaredEditionAssets(manifest).includes(relative)) return null
  const root = fileURLToPath(reviewed.resources.editionRoot)
  return editionAssetPayload(root, manifest, relative, new Set([".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"]))
}
