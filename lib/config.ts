import { configuredValue, resolveRuntimePaths, resolveRuntimePorts } from "../scripts/runtime-config-core.mjs"

import type { T4IntegrationConfig } from "@/lib/types"

const T4_LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  "[::1]": true,
  localhost: true,
}


export { configuredValue }

export function dataDirectory(): string {
  return resolveRuntimePaths().dataDirectory
}

export function databasePath(): string {
  return resolveRuntimePaths().databasePath
}

export function workspaceRoot(): string {
  return resolveRuntimePaths().workspaceRoot
}

export function workspaceRoots(): string[] {
  return resolveRuntimePaths().workspaceRoots
}

export function terminalPort(): number {
  return resolveRuntimePorts().terminalPort
}


export function ompPrewarmEnabled(): boolean {
  return configuredValue("OMP_PREWARM") === "1"
}

export function ompPrewarmTtlMs(): number {
  const configured = Number(configuredValue("OMP_PREWARM_TTL_MS"))
  return Number.isFinite(configured) ? Math.min(300_000, Math.max(5_000, configured)) : 60_000
}

export function t4IntegrationConfig(): T4IntegrationConfig {
  const configured = configuredValue("T4_URL")?.trim()
  if (!configured) return { url: null, error: null }

  try {
    const url = new URL(configured)
    const secure = url.protocol === "https:"
    const loopback = url.protocol === "http:" && T4_LOOPBACK_HOSTS[url.hostname] === true
    if (
      (!secure && !loopback) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid T4 URL")
    }
    return { url: url.toString(), error: null }
  } catch {
    return {
      url: null,
      error: "OPERATOR_ENGINE_T4_URL must be HTTPS, or loopback HTTP, with no credentials, query, or fragment.",
    }
  }
}

export function recipesDirectory(): string {
  return resolveRuntimePaths().recipesDirectory
}

export function editionsDirectory(): string { return resolveRuntimePaths().editionsDirectory }
export function activeEditionPath(): string { return resolveRuntimePaths().activeEditionPath }
