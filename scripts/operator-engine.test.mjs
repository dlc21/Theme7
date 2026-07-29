import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
let server
afterEach(() => new Promise((resolve) => server ? server.close(() => { server = undefined; resolve() }) : resolve()))

const controlEnvironmentKeys = [
  "OPERATOR_ENGINE_CONTROL_ORIGIN",
  "OPERATOR_ENGINE_CONTROL_URL",
  "OPERATOR_ENGINE_CONTROL_TOKEN",
  "OPERATOR_ENGINE_LANE_ID",
  "OPERATOR_ENGINE_PANE_ID",
]

function isolatedEnv(overrides) {
  const env = { ...process.env }
  for (const key of controlEnvironmentKeys) delete env[key]
  return { ...env, ...overrides }
}

function runHelper(args, overrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "operator-engine.mjs"), ...args], {
      env: isolatedEnv(overrides),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""; let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("exit", (code) => resolve({ code, stdout, stderr }))
  })
}

async function listen(handler) {
  server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Unable to bind helper test server.")
  return `http://127.0.0.1:${address.port}`
}

async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

describe("operator-engine helper", () => {
  it("opens the selected location with its scoped capability", async () => {
    let received
    const origin = await listen(async (request, response) => {
      received = {
        path: request.url,
        method: request.method,
        token: request.headers["x-operator-engine-control-token"],
        body: await requestBody(request),
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ location: "demo/index.html" }))
    })
    const result = await runHelper(["open", "demo/index.html"], {
      OPERATOR_ENGINE_LANE_ID: "lane-1",
      OPERATOR_ENGINE_PANE_ID: "terminal-1",
      OPERATOR_ENGINE_CONTROL_URL: `${origin}/api/control/web-preview/open`,
      OPERATOR_ENGINE_CONTROL_TOKEN: "fixture-scoped-token",
    })
    assert.equal(result.code, 0)
    assert.match(result.stdout, /Opened demo\/index\.html/)
    assert.deepEqual(received, {
      path: "/api/control/web-preview/open",
      method: "POST",
      token: "fixture-scoped-token",
      body: { location: "demo/index.html" },
    })
  })

  it("asks the exact terminal close route with an empty body and scoped capability", async () => {
    let received
    const origin = await listen(async (request, response) => {
      received = {
        path: request.url,
        method: request.method,
        token: request.headers["x-operator-engine-control-token"],
        body: await requestBody(request),
      }
      response.writeHead(202, { "content-type": "application/json" })
      response.end(JSON.stringify({ intentId: "intent-1", expiresAt: Date.now() + 60_000 }))
    })
    const result = await runHelper(["close"], {
      OPERATOR_ENGINE_LANE_ID: "lane-1",
      OPERATOR_ENGINE_PANE_ID: "terminal-1",
      OPERATOR_ENGINE_CONTROL_ORIGIN: origin,
      OPERATOR_ENGINE_CONTROL_TOKEN: "fixture-scoped-token",
    })
    assert.equal(result.code, 0)
    assert.equal(result.stdout, "Asked Operator Engine to close this Agent Terminal.\n")
    assert.equal(result.stderr, "")
    assert.deepEqual(received, {
      path: "/api/control/terminal/close",
      method: "POST",
      token: "fixture-scoped-token",
      body: {},
    })
  })


  it("propagates a non-202 close error", async () => {
    const origin = await listen((_request, response) => {
      response.writeHead(409, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "This Agent Terminal is the only pane in the lane." }))
    })
    const result = await runHelper(["close"], {
      OPERATOR_ENGINE_LANE_ID: "lane-1",
      OPERATOR_ENGINE_PANE_ID: "terminal-1",
      OPERATOR_ENGINE_CONTROL_ORIGIN: origin,
      OPERATOR_ENGINE_CONTROL_TOKEN: "fixture-scoped-token",
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /This Agent Terminal is the only pane in the lane\./)
  })

  it("rejects extra close arguments with the exact usage", async () => {
    const result = await runHelper(["close", "now"], {})
    assert.equal(result.code, 1)
    assert.equal(result.stderr, "operator-engine: usage: operator-engine <open <workspace-relative-html-path-or-http-url>|close>\n")
  })

  it("does not derive the close origin from the Web Preview route URL", async () => {
    const result = await runHelper(["close"], {
      OPERATOR_ENGINE_LANE_ID: "lane-1",
      OPERATOR_ENGINE_PANE_ID: "terminal-1",
      OPERATOR_ENGINE_CONTROL_URL: "http://127.0.0.1:1/api/control/web-preview/open",
      OPERATOR_ENGINE_CONTROL_TOKEN: "fixture-scoped-token",
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /available inside an Operator Engine workspace terminal pane/)
  })
})
