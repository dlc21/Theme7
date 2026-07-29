import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { detectHarnesses } from "./harness-adapters.mjs"
import { configuredValue, resolveRuntimePaths } from "./runtime-config-core.mjs"
import { parseEnvFile } from "./state-io.mjs"
import {
  appendTerminalSecret,
  assertAccessPassword,
  assertAccessSessionSecret,
  assertTerminalSecret,
  generatedAccessPassword,
  generatedAccessSessionSecret,
  generatedTerminalSecret,
  renderComposeEnvironment,
  terminalSecretFromEnv,
} from "./setup-secret-policy.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const major = Number(process.versions.node.split(".")[0])
if (major !== 24) throw new Error(`Node 24 LTS is required for this beta; found ${process.version}.`)
try { execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true }) } catch { throw new Error("Git is required and was not found on PATH.") }

const runtimePaths = resolveRuntimePaths()
const data = runtimePaths.dataDirectory
const workspaces = runtimePaths.workspaceRoots
const workspace = runtimePaths.workspaceRoot
const recipes = runtimePaths.recipesDirectory
const editions = runtimePaths.editionsDirectory
for (const directory of [data, ...workspaces, recipes, editions, path.join(data, "home")]) fs.mkdirSync(directory, { recursive: true })

const envFile = path.join(root, ".env.local")
const composeEnvFile = path.join(root, ".env.compose")
const normalized = (value) => value.split(path.sep).join("/")
const existingEnvironment = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : ""
let secret = terminalSecretFromEnv(existingEnvironment)
if (!secret) {
  secret = generatedTerminalSecret()
  const contents = existingEnvironment
    ? appendTerminalSecret(existingEnvironment, secret)
    : [
      "OPERATOR_ENGINE_HOST=127.0.0.1",
      "OPERATOR_ENGINE_PORT=4400",
      "OPERATOR_ENGINE_TERMINAL_PORT=4401",
      `OPERATOR_ENGINE_DATA_DIR=${normalized(data)}`,
      `OPERATOR_ENGINE_DB_PATH=${normalized(path.join(data, "theme7.sqlite"))}`,
      `OPERATOR_ENGINE_WORKSPACE_ROOT=${normalized(workspace)}`,
      ...(workspaces.length > 1 ? [`OPERATOR_ENGINE_WORKSPACE_ROOTS=${workspaces.slice(1).map(normalized).join(path.delimiter)}`] : []),
      `OPERATOR_ENGINE_TERMINAL_SECRET=${secret}`,
      "",
    ].join("\n")
  fs.writeFileSync(envFile, contents, { mode: 0o600 })
}
let composeTerminalSecret = ""
let composeAccessPassword = ""
let composeAccessSessionSecret = ""

if (fs.existsSync(composeEnvFile)) {
  const contents = fs.readFileSync(composeEnvFile, "utf8")
  const parsed = parseEnvFile(contents)
  composeTerminalSecret = parsed["OPERATOR_ENGINE_TERMINAL_SECRET"] || ""
  if (composeTerminalSecret) {
    try { assertTerminalSecret(composeTerminalSecret) } catch { composeTerminalSecret = "" }
  }
  composeAccessPassword = parsed["OPERATOR_ENGINE_ACCESS_PASSWORD"] || ""
  if (composeAccessPassword) {
    try { assertAccessPassword(composeAccessPassword) } catch { composeAccessPassword = "" }
  }
  composeAccessSessionSecret = parsed["OPERATOR_ENGINE_ACCESS_SESSION_SECRET"] || ""
  if (composeAccessSessionSecret) {
    try { assertAccessSessionSecret(composeAccessSessionSecret) } catch { composeAccessSessionSecret = "" }
  }
}

if (!composeTerminalSecret) {
  composeTerminalSecret = secret || generatedTerminalSecret()
}
if (!composeAccessPassword) {
  composeAccessPassword = generatedAccessPassword()
}
if (!composeAccessSessionSecret) {
  composeAccessSessionSecret = generatedAccessSessionSecret()
}

fs.writeFileSync(
  composeEnvFile,
  renderComposeEnvironment(composeTerminalSecret, composeAccessPassword, composeAccessSessionSecret),
  { mode: 0o600 }
)

const detectedHarnesses = await detectHarnesses()
const themeSevenSelected = configuredValue("DISTRIBUTION") === "theme-7"
const providerIds = themeSevenSelected ? ["omp", "shell"] : ["codex", "shell"]
const harnesses = providerIds.map((id) => detectedHarnesses.find((item) => item.id === id)).filter(Boolean)
process.stdout.write(`Operator Engine is configured.\nData: ${data}\nWorkspaces: ${workspaces.join(", ")}\nProviders: ${harnesses.map((item) => `${item.label} ${item.state}`).join(", ")}\n`)
const codex = harnesses.find((item) => item.id === "codex")
if (codex && codex.state !== "available") {
  process.stdout.write("Recommendation: install Codex yourself with npm install --global @openai/codex, then run npm run doctor. Authenticate when you open Codex in an Agent terminal.\n")
}
