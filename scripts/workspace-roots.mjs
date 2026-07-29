import { parseWorkspaceRoots, resolveRuntimePaths } from "./runtime-config-core.mjs"

export { parseWorkspaceRoots }

export function configuredWorkspaceRoots() {
  return resolveRuntimePaths().workspaceRoots
}
