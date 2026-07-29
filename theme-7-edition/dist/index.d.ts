export type HarnessId = "omp" | "codex" | "shell"
export type DistributionId = "stock" | "theme-7"
export type DistributionStarter = { id: "browser-showpiece"; directoryBase: "omp-tour"; entry: "index.html" }
export type GuidedOnboardingTarget = "create-lane" | "directory-picker" | "agent-terminal" | "pane-palette" | "browser"
export type GuidedOnboardingStep = { id: string; target: GuidedOnboardingTarget; secondaryTarget?: GuidedOnboardingTarget; title: string; description: string; descriptionWhenT4?: string; advance: "target-action" | "button"; onEnter?: "open-browser-showpiece" }
export type ReviewedDistributionPackage = { distribution: { id: DistributionId; edition: Record<string, unknown>; providerIds: HarnessId[]; starter?: DistributionStarter; onboarding?: { version: string; intro: { title: string; lines: string[]; actionLabel: string }; steps: GuidedOnboardingStep[] } }; resources: { packageRoot: URL; editionRoot: URL; starters: Record<"browser-showpiece", URL>; identityExtension?: URL } }
export const ompTheme7: ReviewedDistributionPackage
export default ompTheme7
