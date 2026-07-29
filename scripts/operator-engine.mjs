#!/usr/bin/env node

function fail(message) {
  process.stderr.write(`operator-engine: ${message}\n`)
  process.exit(1)
}

const [, , command, ...args] = process.argv
const usage = "usage: operator-engine <open <workspace-relative-html-path-or-http-url>|close>"
const opening = command === "open" && args.length === 1
const closing = command === "close" && args.length === 0
if (!opening && !closing) fail(usage)

const controlUrl = process.env.OPERATOR_ENGINE_CONTROL_URL?.trim()
const controlOrigin = process.env.OPERATOR_ENGINE_CONTROL_ORIGIN?.trim()
const token = process.env.OPERATOR_ENGINE_CONTROL_TOKEN?.trim()
const laneId = process.env.OPERATOR_ENGINE_LANE_ID
const paneId = process.env.OPERATOR_ENGINE_PANE_ID
const target = opening
  ? controlUrl
  : controlOrigin
    ? `${controlOrigin.replace(/\/+$/, "")}/api/control/terminal/close`
    : undefined
if (!target || !token || !laneId || !paneId) fail("this command is available inside an Operator Engine workspace terminal pane")

try {
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-engine-control-token": token },
    body: JSON.stringify(opening ? { location: args[0] } : {}),
    signal: AbortSignal.timeout(5_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (closing) {
    if (response.status !== 202) fail(typeof payload.error === "string" ? payload.error : `request failed (${response.status})`)
    process.stdout.write("Asked Operator Engine to close this Agent Terminal.\n")
  } else {
    if (!response.ok) fail(typeof payload.error === "string" ? payload.error : `request failed (${response.status})`)
    process.stdout.write(`Opened ${payload.location} in Browser.\n`)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "request failed")
}
