export interface RuntimePaths {
  dataDirectory: string
  databasePath: string
  workspaceRoot: string
  workspaceRoots: string[]
  recipesDirectory: string
  editionsDirectory: string
  activeEditionPath: string
}

export interface RuntimePorts { webPort: number; terminalPort: number }
export interface RuntimeHosts { webHost: string; terminalHost: string }

export function configuredValue(name: string, env?: NodeJS.ProcessEnv): string | undefined
export function parseWorkspaceRoots(primary: string, configured?: string, delimiter?: string): string[]
export function resolveRuntimePaths(env?: NodeJS.ProcessEnv, options?: { homeDirectory?: string }): RuntimePaths
export function resolveRuntimePorts(env?: NodeJS.ProcessEnv): RuntimePorts
export function resolveRuntimeHosts(env?: NodeJS.ProcessEnv): RuntimeHosts
export function terminalSecret(env?: NodeJS.ProcessEnv): string
export function terminalLoopbackOrigin(env?: NodeJS.ProcessEnv): string
export function webControlOrigin(env?: NodeJS.ProcessEnv): string
export function accessConfig(env?: NodeJS.ProcessEnv): { mode: "open" } | { mode: "password"; password: string; sessionSecret: string }
