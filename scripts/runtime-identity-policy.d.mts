import type { DistributionId, RuntimeIdentityPublic } from "../lib/distributions"

export function isRuntimeIdentity(value: unknown): value is RuntimeIdentityPublic
export function assertRuntimeIdentity(value: unknown): asserts value is RuntimeIdentityPublic
export function runtimeIdentityFromEnvironment(
  distribution: DistributionId,
  env?: NodeJS.ProcessEnv,
  defaults?: Partial<Pick<RuntimeIdentityPublic, "role" | "mode" | "dataClass">>,
): RuntimeIdentityPublic
