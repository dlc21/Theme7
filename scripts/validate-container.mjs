import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import net from "node:net"

import { fetchOk } from "./network-probe.mjs"
import { CONTAINER_RUNTIME_FILES } from "./runtime-files-policy.mjs"
import { parseEnvFile } from "./state-io.mjs"
import {
  assertAccessPassword,
  assertAccessSessionSecret,
  assertTerminalSecret,
  generatedAccessPassword,
  generatedAccessSessionSecret,
  generatedTerminalSecret,
  renderComposeEnvironment,
  terminalSecretFromEnv,
} from "./setup-secret-policy.mjs"

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate an isolated port."))
      server.close(() => resolve(address.port))
    })
  })
}

function docker(args, env, stdio = "inherit") {
  const result = spawnSync("docker", args, { cwd: process.cwd(), env, stdio, encoding: stdio === "pipe" ? "utf8" : undefined, windowsHide: true })
  if (result.error?.code === "ENOENT") throw new Error("Docker is required for container acceptance.")
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "").trim() || `docker ${args.join(" ")} failed.`)
  return result.stdout ?? ""
}

function bestEffortDocker(args, env) {
  const result = spawnSync("docker", args, { cwd: process.cwd(), env, stdio: "pipe", encoding: "utf8", windowsHide: true })
  if (result.error?.code === "ENOENT") return
  if (result.status !== 0 && !/No such (?:container|image)/i.test(`${result.stderr}\n${result.stdout}`)) {
    process.stderr.write(`Container cleanup warning: ${(result.stderr || result.stdout || "").trim()}\n`)
  }
}

async function waitFor(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fetchOk(url, 2_000)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Container endpoint did not become healthy: ${url}`)
}

async function runtimeCapabilities(port, cookie = "") {
  const headers = {}
  if (cookie) headers["Cookie"] = cookie
  const response = await fetch(`http://127.0.0.1:${port}/api/runtime-capabilities`, {
    headers,
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`Runtime capabilities failed with ${response.status}.`)
  return response.json()
}

function imageReport(image, env) {
  const script = [
    "const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process')",
    "const walk=(root)=>fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(root,e.name)):[path.join(root,e.name)]).map(v=>v.replaceAll('\\\\\\\\','/'))",
    "const theme='/app/node_modules/theme-7/package.json'",
    "const omp=spawnSync('omp',['--version'],{encoding:'utf8'})",
    "const forbidden=['/app/.env.example','/app/.git','/app/.github','/app/AGENTS.md','/app/ARCHITECTURE.md','/app/BUILDING.md','/app/CONTRIBUTING.md','/app/Dockerfile','/app/EXTENDING.md','/app/README.md','/app/SECURITY.md','/app/app','/app/components','/app/compose.yaml','/app/deploy','/app/lib','/app/tests','/app/test-results','/app/vendor','/app/scripts/local-train.mjs','/app/scripts/package-standalone.mjs','/app/scripts/setup.mjs'].filter(fs.existsSync)",
    "const report={scripts:walk('/app/scripts').map(v=>v.slice('/app/'.length)).sort(),theme:fs.existsSync(theme)?JSON.parse(fs.readFileSync(theme,'utf8')):null,ompVersion:omp.status===0?omp.stdout.trim():null,forbidden}",
    "process.stdout.write(JSON.stringify(report))",
  ].join(";")
  return JSON.parse(docker(["run", "--rm", "--entrypoint", "node", image, "-e", script], env, "pipe"))
}

function assertDistribution(payload, expected, expectedHarnesses, expectedTerminalPort) {
  if (payload.distributionId !== expected) throw new Error(`Expected ${expected} container; received ${JSON.stringify(payload.distributionId)}.`)
  const harnesses = payload.harnesses?.map((item) => item.id)
  if (JSON.stringify(harnesses) !== JSON.stringify(expectedHarnesses)) throw new Error(`Unexpected ${expected} harness boundary: ${JSON.stringify(harnesses)}.`)
  if (payload.runtimeIdentity?.terminalPort !== expectedTerminalPort) {
    throw new Error(`Container browser terminal port ${JSON.stringify(payload.runtimeIdentity?.terminalPort)} does not match published relay port ${expectedTerminalPort}.`)
  }
}

const [webPort, terminalPort] = await Promise.all([freePort(), freePort()])
const suffix = `${process.pid}-${Date.now()}`
const project = `theme7-acceptance-${suffix}`
const image = `theme7:acceptance-${suffix}`
const composeEnvironmentPath = path.join(process.cwd(), ".env.compose")
const existingComposeEnvironment = fs.existsSync(composeEnvironmentPath) ? fs.readFileSync(composeEnvironmentPath) : null
const existingComposeText = existingComposeEnvironment?.toString("utf8").replaceAll("\r\n", "\n") ?? ""
const parsedCompose = parseEnvFile(existingComposeText)
let composeTerminalSecret = parsedCompose["OPERATOR_ENGINE_TERMINAL_SECRET"] || ""
let composeAccessPassword = parsedCompose["OPERATOR_ENGINE_ACCESS_PASSWORD"] || ""
let composeAccessSessionSecret = parsedCompose["OPERATOR_ENGINE_ACCESS_SESSION_SECRET"] || ""

if (existingComposeText) {
  try {
    assertTerminalSecret(composeTerminalSecret)
    assertAccessPassword(composeAccessPassword)
    assertAccessSessionSecret(composeAccessSessionSecret)
    if (parsedCompose["OPERATOR_ENGINE_ACCESS_MODE"] !== "password") {
      throw new Error("OPERATOR_ENGINE_ACCESS_MODE is not password")
    }
  } catch (err) {
    throw new Error(`.env.compose is invalid: ${err.message}`)
  }
} else {
  composeTerminalSecret = generatedTerminalSecret()
  composeAccessPassword = generatedAccessPassword()
  composeAccessSessionSecret = generatedAccessSessionSecret()
  fs.writeFileSync(
    composeEnvironmentPath,
    renderComposeEnvironment(composeTerminalSecret, composeAccessPassword, composeAccessSessionSecret),
    { mode: 0o600 }
  )
}
const secret = composeTerminalSecret
const accessPasswordVal = composeAccessPassword
const env = {
  ...process.env,
  THEME7_COMPOSE_HOST: "127.0.0.1",
  THEME7_COMPOSE_WEB_PORT: String(webPort),
  THEME7_COMPOSE_TERMINAL_PORT: String(terminalPort),
  THEME7_COMPOSE_IMAGE: image,
}

try {
  docker(["compose", "-p", project, "config", "--quiet"], env)
  docker(["compose", "-p", project, "up", "-d", "--build", "--wait"], env)
  const codexVersion = docker(["compose", "-p", project, "exec", "-T", "theme7", "codex", "--version"], env, "pipe").trim()
  if (!codexVersion) throw new Error("Bundled Codex did not report a version.")
  const [webOk, relayOk] = await Promise.all([
    fetchOk(`http://127.0.0.1:${webPort}/api/health`, 5_000),
    fetchOk(`http://127.0.0.1:${terminalPort}/healthz`, 5_000),
  ])
  if (!webOk || !relayOk) throw new Error(`Container health failed: web ${webOk}, relay ${relayOk}.`)
  // Assert unauthenticated denial
  const unauthCapRes = await fetch(`http://127.0.0.1:${webPort}/api/runtime-capabilities`, { signal: AbortSignal.timeout(8_000) })
  if (unauthCapRes.status !== 401) {
    throw new Error(`Expected unauthenticated /api/runtime-capabilities to return 401; got ${unauthCapRes.status}`)
  }

  // Assert wrong password denial
  const wrongLoginRes = await fetch(`http://127.0.0.1:${webPort}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-password-of-at-least-24-chars" }),
    signal: AbortSignal.timeout(8_000),
  })
  if (wrongLoginRes.status !== 401) {
    throw new Error(`Expected wrong password login to return 401; got ${wrongLoginRes.status}`)
  }
  if (wrongLoginRes.headers.get("Set-Cookie")) {
    throw new Error("Wrong password login returned a cookie.")
  }

  // Log in with correct password
  const correctLoginRes = await fetch(`http://127.0.0.1:${webPort}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: accessPasswordVal }),
    signal: AbortSignal.timeout(8_000),
  })
  if (correctLoginRes.status !== 204) {
    throw new Error(`Expected correct login to return 204; got ${correctLoginRes.status}`)
  }
  const setCookie = correctLoginRes.headers.get("Set-Cookie")
  if (!setCookie) {
    throw new Error("Correct login did not return a Set-Cookie header.")
  }
  const cookieMatch = setCookie.match(/theme7_access=([^;]+)/)
  if (!cookieMatch) {
    throw new Error("Could not extract theme7_access cookie value.")
  }
  const authCookie = cookieMatch[0]

  assertDistribution(await runtimeCapabilities(webPort, authCookie), "theme-7", ["omp", "shell"], terminalPort)

  const imageId = docker(["image", "inspect", "--format={{.Id}}", image], env, "pipe").trim()
  if (!imageId) throw new Error("Image ID was not returned by docker inspect.")
  const report = imageReport(image, env)
  const expectedScripts = CONTAINER_RUNTIME_FILES.filter((relative) => relative.startsWith("scripts/")).sort()
  if (JSON.stringify(report.scripts) !== JSON.stringify(expectedScripts)) {
    throw new Error("Container runtime script surface differs from the central allowlist.")
  }
  if (report.theme?.name !== "theme-7" || !report.ompVersion || report.forbidden.length) {
    throw new Error(`Container distribution boundary failed: ${JSON.stringify(report)}`)
  }
  process.stdout.write(`Theme Seven container runtime includes ${report.ompVersion}.\n`)
  process.stdout.write(`Theme Seven container acceptance passed on isolated host ports ${webPort}/${terminalPort}.\n`)
} finally {
  bestEffortDocker(["compose", "-p", project, "down", "--volumes", "--remove-orphans"], env)
  bestEffortDocker(["image", "rm", "--force", image], env)
  if (!existingComposeEnvironment) fs.rmSync(composeEnvironmentPath, { force: true })
}
