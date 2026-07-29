import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { accessConfig, configuredValue, resolveRuntimeHosts } from "./runtime-config-core.mjs"
import { validateArtifactManifest } from "./artifact-policy.mjs"
import { runtimeIdentityFromEnvironment } from "./runtime-identity-policy.mjs"
import { parseEnvFile } from "./state-io.mjs"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const mode = process.argv[2] === "dev" ? "dev" : "start"
const children = []

function loadLocalEnvironment() {
  const file = path.join(root, ".env.local")
  if (!fs.existsSync(file)) return
  for (const [name, value] of Object.entries(parseEnvFile(fs.readFileSync(file, "utf8")))) {
    if (process.env[name] === undefined) process.env[name] = value
  }
}
loadLocalEnvironment()
process.env.NEXT_TELEMETRY_DISABLED ??= "1"
function selected(name) {
  return configuredValue(name)
}


function applyRuntimeIdentity() {
  const artifactPath = path.join(root, "artifact.json")
  let artifact = null
  if (fs.existsSync(artifactPath)) {
    artifact = validateArtifactManifest(JSON.parse(fs.readFileSync(artifactPath, "utf8")), { packaged: true })
    for (const [name, authoritative] of [["SOURCE_COMMIT", artifact.sourceCommit], ["DISTRIBUTION", artifact.distribution], ["CONTENT_SHA256", artifact.contentSha256]]) {
      const configured = selected(name)
      if (configured !== undefined && configured !== authoritative) throw new Error(`Runtime ${name.toLowerCase()} conflicts with artifact.json.`)
      process.env[`OPERATOR_ENGINE_${name}`] = authoritative
    }
  } else if (configuredValue("SOURCE_COMMIT") === undefined) {
    try {
      process.env.OPERATOR_ENGINE_SOURCE_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim()
    } catch {}
  }

  const distribution = artifact?.distribution ?? selected("RUNTIME_DISTRIBUTION") ?? selected("DISTRIBUTION") ?? "stock"
  const identity = runtimeIdentityFromEnvironment(distribution, process.env, {
    role: artifact ? "candidate" : "development",
    mode: artifact ? "standalone" : "hmr",
    dataClass: "isolated",
  })
  process.env.OPERATOR_ENGINE_RUNTIME_ROLE = identity.role
  process.env.OPERATOR_ENGINE_RUNTIME_MODE = identity.mode
  process.env.OPERATOR_ENGINE_DATA_CLASS = identity.dataClass
  process.env.OPERATOR_ENGINE_PORT = String(identity.webPort)
  process.env.OPERATOR_ENGINE_TERMINAL_PORT = String(identity.terminalPort)
  if (artifact) {
    process.env.OPERATOR_ENGINE_RUNTIME_DISTRIBUTION = artifact.distribution
    process.env.OPERATOR_ENGINE_STANDALONE = "1"
  }
  return { webPort: identity.webPort }
}

const runtime = applyRuntimeIdentity()
accessConfig()


const { webHost: host } = resolveRuntimeHosts()
const port = String(runtime.webPort)

function launch(command, args, env = process.env, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: true })
  children.push(child)
  child.on("exit", (code, signal) => {
    if (shuttingDown) return
    process.stderr.write(`${path.basename(command)} exited (${signal ?? code ?? "unknown"}).\n`)
    shutdown(code ?? 1)
  })
  return child
}

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) child.kill("SIGTERM")
  setTimeout(() => process.exit(code), 1_500).unref()
}

const relayEnv = { ...process.env }
delete relayEnv.OPERATOR_ENGINE_ACCESS_PASSWORD
delete relayEnv.OPERATOR_ENGINE_ACCESS_SESSION_SECRET
launch(process.execPath, [path.join(root, "scripts", "terminal-relay.mjs")], relayEnv)
if (configuredValue("STANDALONE") === "1") {
  launch(process.execPath, [path.join(root, "server.js")], { ...process.env, HOSTNAME: host, PORT: port })
} else if (mode === "start") {
  const standalone = path.join(root, configuredValue("NEXT_DIST_DIR") ?? ".next", "standalone")
  launch(process.execPath, [path.join(standalone, "server.js")], { ...process.env, HOSTNAME: host, PORT: port }, standalone)
} else {
  const nextBin = require.resolve("next/dist/bin/next")
  launch(process.execPath, [nextBin, mode, "--webpack", "--hostname", host, "--port", port])
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))
await new Promise(() => {})
