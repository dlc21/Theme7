import type { DistributionId } from "@/lib/distributions"
import type { HarnessAvailability, HarnessId } from "@/lib/types"

const PROVIDERS: Record<DistributionId, readonly HarnessId[]> = {
  stock: ["codex", "shell"],
  "theme-7": ["omp", "shell"],
}

export function providerIdsForDistribution(distributionId: DistributionId): readonly HarnessId[] {
  return PROVIDERS[distributionId]
}

export function canStartNewHarness(id: HarnessId, distributionId: DistributionId): boolean {
  return PROVIDERS[distributionId].includes(id)
}

export function orderHarnesses(harnesses: HarnessAvailability[], distributionId: DistributionId): HarnessAvailability[] {
  const providers = PROVIDERS[distributionId]
  return harnesses
    .filter((harness) => providers.includes(harness.id))
    .sort((left, right) => providers.indexOf(left.id) - providers.indexOf(right.id))
}

export function firstAvailableNewHarness(harnesses: HarnessAvailability[], distributionId: DistributionId): HarnessId {
  return orderHarnesses(harnesses, distributionId).find((item) => item.state === "available")?.id ?? "shell"
}

export function newLaneHarness(value: unknown, distributionId: DistributionId): HarnessId {
  return typeof value === "string" && PROVIDERS[distributionId].includes(value as HarnessId) ? value as HarnessId : "shell"
}
