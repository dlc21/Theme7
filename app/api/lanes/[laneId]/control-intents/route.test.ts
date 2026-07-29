import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defaultLayout } from "@/lib/bento-layout"
import type * as ControlIntentRouteModule from "@/app/api/lanes/[laneId]/control-intents/route"
import type * as ClientControlIntentsModule from "@/lib/client-control-intents"
import type * as DbModule from "@/lib/db"

const originalDataDirectory = process.env.OPERATOR_ENGINE_DATA_DIR
const globals = globalThis as typeof globalThis & {
  operatorEngineDatabase?: { close(): void }
  operatorEngineClientControlIntents?: Map<string, unknown>
}

let root = ""
let laneIndex = 0
let db: typeof DbModule
let intents: typeof ClientControlIntentsModule
let route: typeof ControlIntentRouteModule

async function createLane() {
  const folder = path.join(root, `workspace-${laneIndex++}`)
  await fs.mkdir(folder, { recursive: true })
  return db.createLane({
    name: path.basename(folder),
    path: folder,
    layout: { schemaVersion: 1, tree: defaultLayout() },
    recipeId: null,
    recipeVersion: null,
    defaultHarness: "shell",
  })
}

function context(laneId: string) {
  return { params: Promise.resolve({ laneId }) }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "operator-engine-control-intents-route-"))
  laneIndex = 0
  process.env.OPERATOR_ENGINE_DATA_DIR = root
  globals.operatorEngineDatabase?.close()
  delete globals.operatorEngineDatabase
  delete globals.operatorEngineClientControlIntents
  // The process-global database and queue require a fresh module graph for each isolated data directory.
  vi.resetModules()
  db = await import("@/lib/db")
  intents = await import("@/lib/client-control-intents")
  route = await import("@/app/api/lanes/[laneId]/control-intents/route")
})

afterEach(async () => {
  globals.operatorEngineDatabase?.close()
  delete globals.operatorEngineDatabase
  delete globals.operatorEngineClientControlIntents
  if (originalDataDirectory === undefined) delete process.env.OPERATOR_ENGINE_DATA_DIR
  else process.env.OPERATOR_ENGINE_DATA_DIR = originalDataDirectory
  await fs.rm(root, { recursive: true, force: true })
})

describe("lane browser control intents", () => {
  it("lists and acknowledges intents only within the requested lane", async () => {
    const firstLane = await createLane()
    const secondLane = await createLane()
    const firstIntent = intents.queueClientControlIntent({
      kind: "open_web_preview",
      laneId: firstLane.id,
      sourcePaneId: "terminal-main",
      location: "demo/index.html",
    })
    const secondIntent = intents.queueClientControlIntent({
      kind: "close_terminal",
      laneId: secondLane.id,
      sourcePaneId: "terminal-main",
      expectedGeneration: 1,
    })

    const listed = await route.GET(new Request(`http://localhost/api/lanes/${firstLane.id}/control-intents`), context(firstLane.id))
    expect(listed.status).toBe(200)
    expect(listed.headers.get("cache-control")).toBe("no-store")
    await expect(listed.json()).resolves.toEqual({ intents: [firstIntent] })

    const crossLaneDelete = await route.DELETE(
      new Request(`http://localhost/api/lanes/${firstLane.id}/control-intents?intentId=${secondIntent.id}`, { method: "DELETE" }),
      context(firstLane.id),
    )
    await expect(crossLaneDelete.json()).resolves.toEqual({ acknowledged: false })
    expect(intents.listClientControlIntents(secondLane.id)).toEqual([secondIntent])

    const ownDelete = await route.DELETE(
      new Request(`http://localhost/api/lanes/${firstLane.id}/control-intents?intentId=${firstIntent.id}`, { method: "DELETE" }),
      context(firstLane.id),
    )
    await expect(ownDelete.json()).resolves.toEqual({ acknowledged: true })
    expect(intents.listClientControlIntents(firstLane.id)).toEqual([])
  })

  it("returns not found for GET and DELETE on a missing lane", async () => {
    const laneId = "missing-lane"
    const getResponse = await route.GET(new Request(`http://localhost/api/lanes/${laneId}/control-intents`), context(laneId))
    const deleteResponse = await route.DELETE(
      new Request(`http://localhost/api/lanes/${laneId}/control-intents?intentId=missing`, { method: "DELETE" }),
      context(laneId),
    )
    expect(getResponse.status).toBe(404)
    expect(deleteResponse.status).toBe(404)
  })
})
