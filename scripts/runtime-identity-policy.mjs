import { configuredValue, resolveRuntimePorts } from "./runtime-config-core.mjs"

const COMMIT = /^[a-f0-9]{7,64}$/i
const RELEASE = /^[A-Za-z0-9._-]{1,128}$/
const CONTENT = /^[a-f0-9]{64}$/i

export function isRuntimeIdentity(value) {
  return Boolean(value && typeof value === "object"
    && (value.sourceCommit === null || (typeof value.sourceCommit === "string" && COMMIT.test(value.sourceCommit)))
    && (value.distribution === "stock" || value.distribution === "theme-7")
    && ["development", "candidate", "promoted"].includes(value.role)
    && (value.mode === "hmr" || value.mode === "standalone")
    && Number.isInteger(value.webPort) && value.webPort >= 1 && value.webPort <= 65_535
    && Number.isInteger(value.terminalPort) && value.terminalPort >= 1 && value.terminalPort <= 65_535
    && (value.dataClass === "isolated" || value.dataClass === "durable")
    && (value.releaseId === null || (typeof value.releaseId === "string" && RELEASE.test(value.releaseId)))
    && (value.contentSha256 === null || (typeof value.contentSha256 === "string" && CONTENT.test(value.contentSha256))))
}

export function assertRuntimeIdentity(value) {
  if (!isRuntimeIdentity(value)) throw new Error("Invalid runtime identity.")
}

function enumValue(name, values, fallback, env) {
  const value = configuredValue(name, env)?.trim() || fallback
  if (!values.includes(value)) throw new Error(`Invalid OPERATOR_ENGINE_${name}.`)
  return value
}

function optionalIdentity(name, pattern, env) {
  const value = configuredValue(name, env)?.trim()
  if (!value) return null
  if (!pattern.test(value)) throw new Error(`Invalid OPERATOR_ENGINE_${name}.`)
  return value
}

export function runtimeIdentityFromEnvironment(distribution, env = process.env, defaults = {}) {
  if (distribution !== "stock" && distribution !== "theme-7") throw new Error("Invalid runtime identity.")
  const { webPort, terminalPort } = resolveRuntimePorts(env)
  return {
    sourceCommit: optionalIdentity("SOURCE_COMMIT", COMMIT, env),
    distribution,
    role: enumValue("RUNTIME_ROLE", ["development", "candidate", "promoted"], defaults.role ?? "development", env),
    mode: enumValue("RUNTIME_MODE", ["hmr", "standalone"], defaults.mode ?? "hmr", env),
    webPort,
    terminalPort,
    dataClass: enumValue("DATA_CLASS", ["isolated", "durable"], defaults.dataClass ?? "isolated", env),
    releaseId: optionalIdentity("RELEASE_ID", RELEASE, env),
    contentSha256: optionalIdentity("CONTENT_SHA256", CONTENT, env),
  }
}
