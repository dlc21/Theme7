import { execFileSync } from "node:child_process"
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { detectHarnesses } from "./harness-adapters.mjs"
import { fetchOk, portAvailable } from "./network-probe.mjs"
import { configuredValue, resolveRuntimePaths, resolveRuntimePorts, terminalLoopbackOrigin, webControlOrigin } from "./runtime-config-core.mjs"

const require = createRequire(import.meta.url)
const json = process.argv.includes("--json")
const paths = resolveRuntimePaths()
const ports = resolveRuntimePorts()
const results = []
const dataDirectory = () => paths.dataDirectory
const workspaceRoots = () => paths.workspaceRoots
const recipesDirectory = () => paths.recipesDirectory
const databasePath = () => paths.databasePath
const terminalPort = () => ports.terminalPort
const add = (id, ok, detail, extra = {}) => results.push({ id, ok, detail, ...extra })
const safePath = (value) => path.resolve(value)
const commandVersion = (command, args = ["--version"]) => { try { const windowsNpm = process.platform === "win32" && command === "npm"; const actual = windowsNpm ? (process.env.ComSpec ?? "cmd.exe") : command; const actualArgs = windowsNpm ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args; return execFileSync(actual, actualArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim().split(/\r?\n/)[0].slice(0, 120) } catch { return null } }
const canUse = async (directory) => { try { fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, `.doctor-${process.pid}`); fs.writeFileSync(file, "ok"); fs.readFileSync(file); fs.rmSync(file); return true } catch { return false } }

add("platform", process.platform !== "linux" || !/musl/i.test(os.release()), `${process.platform}/${process.arch}`, { supported: ["win32/detected", "darwin/detected", "linux/glibc only"] })
add("node", Number(process.versions.node.split(".")[0]) === 24, process.version, { expected: "Node 24 LTS" })
add("npm", Boolean(commandVersion("npm")), commandVersion("npm") ?? "not found")
add("git", Boolean(commandVersion("git")), commandVersion("git") ?? "not found")
for (const [id, value] of [["data", dataDirectory()], ["recipes", recipesDirectory()], ["database", databasePath()]]) add(`path:${id}`, true, safePath(value))
for (const [index, value] of workspaceRoots().entries()) add(`path:workspace-${index + 1}`, true, safePath(value))
for (const [id, value] of [["data", dataDirectory()], ["recipes", recipesDirectory()], ...workspaceRoots().map((value, index) => [`workspace-${index + 1}`, value])]) add(`writable:${id}`, await canUse(value), "create/read/write probe")
for (const [id, port] of [["web-port", ports.webPort], ["terminal-port", ports.terminalPort]]) add(`port:${id}`, await portAvailable(port), `127.0.0.1:${port}`)
try { const Database = require("better-sqlite3"); const file = path.join(os.tmpdir(), `operator-engine-doctor-${process.pid}.sqlite`); const db = new Database(file); db.exec("create table t (value text)"); db.prepare("insert into t values (?)").run("ok"); add("sqlite", db.prepare("select value from t").get().value === "ok", "native load and disposable CRUD"); db.close(); fs.rmSync(file, { force: true }) } catch (error) { add("sqlite", false, error instanceof Error ? error.message.split("\n")[0] : "native SQLite failed") }
try { const pty = require("@lydell/node-pty"); const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh"); const child = pty.spawn(shell, process.platform === "win32" ? ["/d", "/c", "echo doctor-ok"] : ["-c", "printf doctor-ok"], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env }); const output = await new Promise((resolve) => { let text = ""; const timer = setTimeout(() => { child.kill(); resolve(text) }, 2500); child.onData((value) => { text += value; if (text.includes("doctor-ok")) { clearTimeout(timer); child.kill(); resolve(text) } }) }); add("pty", output.includes("doctor-ok"), "native shell spawn and nonce") } catch (error) { add("pty", false, error instanceof Error ? error.message.split("\n")[0] : "native PTY failed") }
const harnesses = await detectHarnesses()
const distributionSelector = configuredValue("DISTRIBUTION")
const selectedThemeSeven = distributionSelector === "theme-7"
const knownDistribution = distributionSelector === undefined || distributionSelector === "" || distributionSelector === "stock" || selectedThemeSeven
if (!knownDistribution) {
  add("distribution", false, "Unknown OPERATOR_ENGINE_DISTRIBUTION selection. Set OPERATOR_ENGINE_DISTRIBUTION=stock or theme-7.")
} else if (selectedThemeSeven && !harnesses.some((harness) => harness.id === "omp" && harness.state === "available")) {
  add("distribution", false, "Theme Seven was selected but OMP is unavailable. Install or fix OMP, or set OPERATOR_ENGINE_DISTRIBUTION=stock.")
} else {
  add("distribution", true, selectedThemeSeven ? "Theme Seven selected and OMP is available." : "Stock selected.")
}
const providerIds = selectedThemeSeven ? ["omp", "shell"] : ["codex", "shell"]
for (const harness of providerIds.map((id) => harnesses.find((item) => item.id === id)).filter(Boolean)) {
  const required = harness.id === "shell"
  add(`harness:${harness.id}`, required ? harness.state === "available" : true, `${harness.state}${harness.version ? ` (${harness.version})` : ""}`, {
    state: harness.state,
    warning: !required && harness.state !== "available",
  })
}
add("network-posture", true, `proxy ${process.env.HTTP_PROXY || process.env.HTTPS_PROXY ? "detected" : "not detected"}; custom CA ${process.env.NODE_EXTRA_CA_CERTS ? "configured" : "not detected"}`)
for (const [id, url] of [["web-health", `${webControlOrigin()}/api/health`], ["relay-health", `${terminalLoopbackOrigin()}/healthz`]]) { const healthy = await fetchOk(url, 800); add(id, true, healthy ? "running and healthy" : "not running (optional)", healthy ? {} : { skipped: true }) }
for (const [portId, healthId] of [["port:web-port", "web-health"], ["port:terminal-port", "relay-health"]]) { const port = results.find((result) => result.id === portId); const health = results.find((result) => result.id === healthId); if (port && health?.detail === "running and healthy") { port.ok = true; port.detail += "; occupied by healthy Operator Engine service" } }
const envFile = path.resolve(".env.local")
if (!fs.existsSync(envFile)) {
  add("secret-hygiene", true, "config not initialized")
} else if (process.platform === "win32") {
  add("secret-hygiene", true, "config exists; POSIX mode check is not applicable on Windows", { warning: true })
} else {
  try {
    const restrictive = (fs.statSync(envFile).mode & 0o077) === 0
    add("secret-hygiene", restrictive, restrictive ? "config exists with restrictive permissions" : "config permissions are broader than 0600")
  } catch {
    add("secret-hygiene", false, "config permissions could not be read")
  }
}
if (json) process.stdout.write(`${JSON.stringify({ telemetry: false, results }, null, 2)}\n`)
else { process.stdout.write("Operator Engine doctor (zero telemetry; safe to paste)\n\n"); for (const result of results) process.stdout.write(`${result.warning ? "WARN" : result.ok ? "PASS" : "FAIL"} ${result.id}: ${result.detail}\n`); process.stdout.write("\nNo secrets, credential values, or raw environment values are printed.\n") }
process.exitCode = results.some((result) => !result.ok && !result.skipped) ? 1 : 0
