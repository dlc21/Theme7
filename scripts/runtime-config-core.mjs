import os from "node:os"
import path from "node:path"

export function configuredValue(name, env = process.env) {
  return env[`OPERATOR_ENGINE_${name}`]
}

export function parseWorkspaceRoots(primary, configured = "", delimiter = path.delimiter) {
  const candidates = [primary, ...String(configured ?? "").split(delimiter)]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .map((value) => path.resolve(value))
  const unique = new Map()
  for (const root of candidates) {
    const key = process.platform === "win32" ? root.toLowerCase() : root
    if (!unique.has(key)) unique.set(key, root)
  }
  return [...unique.values()]
}

export function resolveRuntimePaths(env = process.env, options = {}) {
  const homeDirectory = options.homeDirectory ?? os.homedir()
  const dataDirectory = path.resolve(configuredValue("DATA_DIR", env) ?? path.join(homeDirectory, ".operator-engine"))
  const databasePath = path.resolve(configuredValue("DB_PATH", env) ?? path.join(dataDirectory, "theme7.sqlite"))
  const workspaceRoot = path.resolve(configuredValue("WORKSPACE_ROOT", env) ?? path.join(dataDirectory, "workspace"))
  const workspaceRoots = parseWorkspaceRoots(workspaceRoot, configuredValue("WORKSPACE_ROOTS", env) ?? "")
  return {
    dataDirectory,
    databasePath,
    workspaceRoot,
    workspaceRoots,
    recipesDirectory: path.join(dataDirectory, "recipes"),
    editionsDirectory: path.join(dataDirectory, "editions"),
    activeEditionPath: path.join(dataDirectory, "active-edition.json"),
  }
}

function port(value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`Invalid OPERATOR_ENGINE_${name}.`)
  return parsed
}

export function resolveRuntimePorts(env = process.env) {
  return {
    webPort: port(configuredValue("PORT", env) ?? "4400", "PORT"),
    terminalPort: port(configuredValue("TERMINAL_PORT", env) ?? "4401", "TERMINAL_PORT"),
  }
}

export function resolveRuntimeHosts(env = process.env) {
  const webHost = configuredValue("HOST", env) ?? "127.0.0.1"
  return { webHost, terminalHost: configuredValue("TERMINAL_HOST", env) ?? webHost }
}

export function terminalSecret(env = process.env) {
  const secret = configuredValue("TERMINAL_SECRET", env)?.trim()
  if (secret) return secret
  if (env.NODE_ENV === "production") throw new Error("OPERATOR_ENGINE_TERMINAL_SECRET is required in production.")
  return "operator-engine-local-terminal"
}

export function terminalLoopbackOrigin(env = process.env) {
  return `http://127.0.0.1:${resolveRuntimePorts(env).terminalPort}`
}

export function webControlOrigin(env = process.env) {
  return `http://127.0.0.1:${resolveRuntimePorts(env).webPort}`
}

export function accessConfig(env = process.env) {
  const mode = configuredValue("ACCESS_MODE", env)
  if (mode === undefined || mode === "") {
    if (env.NODE_ENV === "production") {
      throw new Error("production requires explicit OPERATOR_ENGINE_ACCESS_MODE=open|password")
    }
    return { mode: "open" }
  }
  if (mode === "open") {
    return { mode: "open" }
  }
  if (mode === "password") {
    const password = configuredValue("ACCESS_PASSWORD", env)
    const sessionSecret = configuredValue("ACCESS_SESSION_SECRET", env)
    if (!password || password.length < 24) {
      throw new Error("OPERATOR_ENGINE_ACCESS_PASSWORD must be at least 24 characters.")
    }
    if (!sessionSecret || sessionSecret.length < 32) {
      throw new Error("OPERATOR_ENGINE_ACCESS_SESSION_SECRET must be at least 32 characters.")
    }
    return { mode: "password", password, sessionSecret }
  }
  throw new Error(`Invalid OPERATOR_ENGINE_ACCESS_MODE: ${mode}`)
}
