import { createHmac } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defaultLayout } from "@/lib/bento-layout"
import type * as CloseRouteModule from "@/app/api/control/terminal/close/route"
import type * as ClientControlIntentsModule from "@/lib/client-control-intents"
import type * as DbModule from "@/lib/db"
import type * as TerminalTicketModule from "@/lib/terminal-ticket"

const secret = "terminal-close-route-secret"
const originalDataDirectory = process.env.OPERATOR_ENGINE_DATA_DIR
const originalTerminalSecret = process.env.OPERATOR_ENGINE_TERMINAL_SECRET
const globals = globalThis as typeof globalThis & {
  operatorEngineDatabase?: { close(): void }
  operatorEngineClientControlIntents?: Map<string, unknown>
}

let root = ""
let laneIndex = 0
let db: typeof DbModule
let capability: typeof TerminalTicketModule
let intents: typeof ClientControlIntentsModule
let closeRoute: typeof CloseRouteModule

function restoreEnvironment() {
  if (originalDataDirectory === undefined) delete process.env.OPERATOR_ENGINE_DATA_DIR
  else process.env.OPERATOR_ENGINE_DATA_DIR = originalDataDirectory
  if (originalTerminalSecret === undefined) delete process.env.OPERATOR_ENGINE_TERMINAL_SECRET
  else process.env.OPERATOR_ENGINE_TERMINAL_SECRET = originalTerminalSecret
}

function signCapability(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = createHmac("sha256", secret).update(body).digest("base64url")
  return `${body}.${signature}`
}

async function createLane(panes: string[] = ["terminal", "files"]) {
  const folder = path.join(root, `workspace-${laneIndex++}`)
  await fs.mkdir(folder, { recursive: true })
  return db.createLane({
    name: path.basename(folder),
    path: folder,
    layout: { schemaVersion: 1, tree: defaultLayout(panes) },
    recipeId: null,
    recipeVersion: null,
    defaultHarness: "shell",
  })
}

function request(token = "", tokenHeader = "x-operator-engine-control-token", host = "127.0.0.1:4400"): Request {
  return new Request("http://127.0.0.1:4400/api/control/terminal/close", {
    method: "POST",
    headers: { host, [tokenHeader]: token },
  })
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-close-route-"))
  laneIndex = 0
  process.env.OPERATOR_ENGINE_DATA_DIR = root
  process.env.OPERATOR_ENGINE_TERMINAL_SECRET = secret
  globals.operatorEngineDatabase?.close()
  delete globals.operatorEngineDatabase
  delete globals.operatorEngineClientControlIntents
  // The process-global database and queue require a fresh module graph for each isolated data directory.
  vi.resetModules()
  db = await import("@/lib/db")
  capability = await import("@/lib/terminal-ticket")
  intents = await import("@/lib/client-control-intents")
  closeRoute = await import("@/app/api/control/terminal/close/route")
})

afterEach(async () => {
  globals.operatorEngineDatabase?.close()
  delete globals.operatorEngineDatabase
  delete globals.operatorEngineClientControlIntents
  restoreEnvironment()
  await fs.rm(root, { recursive: true, force: true })
})

describe("POST /api/control/terminal/close", () => {
  it("rejects non-loopback requests before capability handling", async () => {
    const response = await closeRoute.POST(request("", "x-operator-engine-control-token", "client.example"))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "The terminal control route is loopback-only." })
  })

  it("accepts the canonical scoped header", async () => {
    const lane = await createLane()
    const token = capability.signTerminalControlCapability({ laneId: lane.id, paneId: "terminal-main", generation: 1 })
    const response = await closeRoute.POST(request(token, "x-operator-engine-control-token"))
    const body = await response.json()
    expect(response.status).toBe(202)
    expect(body).toEqual({ intentId: expect.any(String), expiresAt: expect.any(Number) })
  })

  it("rejects invalid, expired, and action-missing capabilities", async () => {
    const lane = await createLane()
    const common = { laneId: lane.id, paneId: "terminal-main", generation: 1 }
    const expired = signCapability({ ...common, actions: ["open_web_preview", "close_terminal"], expiresAt: Date.now() - 1 })
    const actionMissing = signCapability({ ...common, actions: ["open_web_preview"], expiresAt: Date.now() + 60_000 })

    for (const token of ["invalid", expired, actionMissing]) {
      const response = await closeRoute.POST(request(token))
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({ error: "Terminal control capability is invalid or expired." })
    }
  })

  it("returns not found for a capability lane that does not exist", async () => {
    const token = capability.signTerminalControlCapability({ laneId: "missing-lane", paneId: "terminal-main", generation: 1 })
    const response = await closeRoute.POST(request(token))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "Lane not found." })
  })

  it("rejects stale and non-terminal source panes", async () => {
    const lane = await createLane()
    for (const paneId of ["terminal-missing", "files-main"]) {
      const token = capability.signTerminalControlCapability({ laneId: lane.id, paneId, generation: 1 })
      const response = await closeRoute.POST(request(token))
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: "Source terminal pane is no longer in this lane." })
    }
  })

  it("keeps the final terminal pane in the lane", async () => {
    const lane = await createLane(["terminal"])
    const token = capability.signTerminalControlCapability({ laneId: lane.id, paneId: "terminal-main", generation: 1 })
    const response = await closeRoute.POST(request(token))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "This Agent Terminal is the only pane in the lane." })
  })

  it("coalesces duplicate close commands into one unexpired intent", async () => {
    const lane = await createLane()
    const token = capability.signTerminalControlCapability({ laneId: lane.id, paneId: "terminal-main", generation: 1 })
    const first = await closeRoute.POST(request(token))
    const second = await closeRoute.POST(request(token))
    const firstBody = await first.json()
    const secondBody = await second.json()

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(secondBody).toEqual(firstBody)
    expect(intents.listClientControlIntents(lane.id)).toHaveLength(1)
  })
})
