import { expect, test, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"

type BrowserLane = { id: string; name: string; path: string }

const configuredT4Url = process.env.OPERATOR_ENGINE_T4_URL?.trim() ?? ""
const browserDistribution = process.env.OPERATOR_ENGINE_TEST_DISTRIBUTION ?? "stock"

test.beforeEach(async ({ page }) => {
  if (browserDistribution !== "theme-7") return
  await page.addInitScript(() => localStorage.setItem("operator-engine:distribution-onboarding:v1:theme-7:1", JSON.stringify({ stepId: "intro", completed: true })))
})

function isBrowserLane(value: unknown): value is BrowserLane {
  return value !== null && typeof value === "object"
    && "id" in value && typeof value.id === "string"
    && "name" in value && typeof value.name === "string"
    && "path" in value && typeof value.path === "string"
}

async function createShellLane(page: Page, name: string): Promise<{ folder: string; lane: BrowserLane }> {
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const folder = path.join(dataDirectory, "workspace", `${name}-${Date.now()}`)
  await fs.mkdir(folder, { recursive: true })

  const created = await page.request.post("/api/lanes", {
    data: { path: folder, name, defaultHarness: "shell", existingFolderUnchanged: true },
  })
  const payload: unknown = await created.json()
  expect(created.ok(), JSON.stringify(payload)).toBe(true)
  if (!payload || typeof payload !== "object" || !("lane" in payload) || !isBrowserLane(payload.lane)) {
    throw new Error("Lane API did not return the T4 browser-test lane.")
  }
  return { folder, lane: payload.lane }
}

async function removeShellLane(page: Page, lane: BrowserLane, folder: string): Promise<void> {
  await page.request.delete(`/api/lanes/${lane.id}`)
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

test("hides T4 Code when OPERATOR_ENGINE_T4_URL is absent", async ({ page }) => {
  test.skip(configuredT4Url !== "", "This proof requires OPERATOR_ENGINE_T4_URL to be absent.")
  const { folder, lane } = await createShellLane(page, "T4 absent smoke")

  try {
    await page.goto(`/lanes/${lane.id}`)
    await page.getByLabel("Open application sidebar").click()
    await expect(page.getByTitle("Click or drag to add T4 Code")).toHaveCount(0)
  } finally {
    await removeShellLane(page, lane, folder)
  }
})

test("loads the configured T4 Code instance in its pane", async ({ page }) => {
  test.skip(configuredT4Url === "", "This proof requires OPERATOR_ENGINE_T4_URL to be configured.")
  const configuredUrl = new URL(configuredT4Url)
  if (configuredUrl.protocol !== "http:" || configuredUrl.hostname !== "127.0.0.1") {
    throw new Error("The configured T4 browser proof requires a loopback HTTP URL on 127.0.0.1.")
  }

  const fixture = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><title>T4 fixture</title><p>T4 iframe fixture</p><script>window.parent.postMessage({ type: "t4-code:ready", version: 1 }, "*")</script>`)
  })
  let fixtureListening = false
  let laneFixture: { folder: string; lane: BrowserLane } | null = null

  try {
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject)
      fixture.listen(Number(configuredUrl.port || "80"), configuredUrl.hostname, () => {
        fixture.off("error", reject)
        fixtureListening = true
        resolve()
      })
    })

    laneFixture = await createShellLane(page, "T4 configured smoke")
    await page.goto(`/lanes/${laneFixture.lane.id}`)
    await page.getByLabel("Open application sidebar").click()
    await page.getByTitle("Click or drag to add T4 Code").click()

    const frame = page.locator('iframe[title="T4 Code"]')
    const expectedSource = new URL(configuredUrl)
    expectedSource.searchParams.set("embed", "1")
    await expect(frame).toHaveCount(1)
    await expect(frame).toHaveAttribute("src", expectedSource.toString())
    await expect(page.frameLocator('iframe[title="T4 Code"]').getByText("T4 iframe fixture", { exact: true })).toBeVisible()
    await expect(page.getByText("Opening T4 Code", { exact: true })).toHaveCount(0)
    await expect.poll(async () => {
      const saved = await page.request.get(`/api/lanes/${laneFixture!.lane.id}`)
      const payload: unknown = await saved.json()
      return saved.ok() && JSON.stringify(payload).includes("\"t4-code\"")
    }).toBe(true)

    await page.reload()
    await expect(frame).toHaveCount(1)
    await expect(frame).toHaveAttribute("src", expectedSource.toString())
    await expect(page.frameLocator('iframe[title="T4 Code"]').getByText("T4 iframe fixture", { exact: true })).toBeVisible()
    await expect(page.getByText("Opening T4 Code", { exact: true })).toHaveCount(0)
  } finally {
    if (laneFixture) await removeShellLane(page, laneFixture.lane, laneFixture.folder)
    if (fixtureListening) {
      await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()))
    }
  }
})
