import { expect, test } from "@playwright/test"
import { STOCK_FORBIDDEN_TEXT } from "../../scripts/check-public-surface.mjs"
import fs from "node:fs/promises"
import path from "node:path"

const requested = process.env.OPERATOR_ENGINE_TEST_DISTRIBUTION ?? "stock"
const expected = process.env.OPERATOR_ENGINE_TEST_EXPECTED_DISTRIBUTION ?? requested
const assertStockTextAbsent = (text: string) => {
  for (const forbidden of STOCK_FORBIDDEN_TEXT) expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase())
}

test("keeps the reviewed distribution boundary explicit", async ({ page }) => {
  const runtimeResponse = await page.request.get("/api/runtime-capabilities")
  expect(runtimeResponse.ok()).toBe(true)
  const runtime = await runtimeResponse.json() as { distributionId: string; harnesses: Array<{ id: string }> }
  expect(runtime.distributionId).toBe(expected)

  await page.goto("/")
  await expect(page).toHaveTitle("Operator Engine")

  if (expected === "stock") {
    expect(runtime.harnesses.map((item) => item.id)).toEqual(["codex", "shell"])
    const chooseFolder = page.getByRole("dialog", { name: "Choose the folder for this work lane" })
    if (!(await chooseFolder.isVisible())) await page.getByRole("button", { name: "Add work lane" }).first().click()
    await expect(chooseFolder).toBeVisible()
    assertStockTextAbsent(await page.locator("body").innerText())
    await expect(page.locator("html")).toHaveAttribute("data-distribution", "stock")
    if (requested !== "stock") await expect(page.getByRole("dialog", { name: "start with one job" })).toHaveCount(0)
  } else {
    expect(runtime.harnesses.map((item) => item.id)).toEqual(["omp", "shell"])
    const skipTour = page.getByRole("button", { name: "skip tour" })
    await expect(skipTour).toBeVisible()
    await expect(page.getByRole("dialog")).toContainText("start with one job")
    await skipTour.click()
  }

  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? "4400"
  const data = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const folder = path.join(data, "workspace", `distribution-${expected}-${Date.now()}`)
  await fs.mkdir(folder, { recursive: true })
  const created = await page.request.post("/api/lanes", {
    data: {
      path: path.basename(folder),
      name: "Boundary check",
      recipeId: "existing-folder",
      existingFolderUnchanged: true,
      defaultHarness: expected === "stock" ? "codex" : "omp",
    },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const payload = await created.json() as { lane: { id: string } }

  try {
    await page.goto(`/lanes/${payload.lane.id}`)
    const terminal = page.locator('[data-pane-id="terminal-main"]')
    await expect(terminal.locator("[data-terminal-preflight]")).toBeVisible()
    await terminal.getByRole("button", { name: "Change" }).click()
    const cards = terminal.locator('[data-operator-engine-slot^="agent-card:"]')
    await expect(cards).toHaveCount(2)

    if (expected === "stock") {
      await expect(terminal.locator("[data-selected-agent]")).toContainText("Codex")
      await expect(terminal.locator('[data-operator-engine-slot="agent-card:codex"]')).toBeVisible()
      await expect(terminal.locator('[data-operator-engine-slot="agent-card:shell"]')).toBeVisible()
      await expect(terminal.locator('[data-operator-engine-slot="agent-card:omp"]')).toHaveCount(0)
      await terminal.getByRole("button", { name: "Open Codex in this folder" }).click()
      await expect(terminal.locator(".xterm")).toBeVisible({ timeout: 10_000 })
      assertStockTextAbsent(await page.locator("body").innerText())
      await page.getByLabel("Open application sidebar").click()
      const panePalette = page.locator('[data-bento-palette="true"]')
      await expect(panePalette.getByTitle("Click or drag to add Agent terminal")).toBeVisible()
      await expect(panePalette.getByTitle("Click or drag to add Files")).toBeVisible()
      await expect(panePalette.getByTitle("Click or drag to add Browser")).toBeVisible()
      await expect(panePalette.getByTitle(/Activity/i)).toHaveCount(0)
      await expect(panePalette.getByTitle(/Session History/i)).toHaveCount(0)
      await page.getByLabel("Close application sidebar").click()
    } else {
      await expect(terminal.locator("[data-selected-agent]")).toContainText("OMP")
      await expect(terminal.locator('[data-operator-engine-slot="agent-card:omp"]')).toBeVisible()
      await expect(terminal.locator('[data-operator-engine-slot="agent-card:shell"]')).toBeVisible()
      await expect(terminal.locator('[data-operator-engine-slot="agent-card:codex"]')).toHaveCount(0)
      await expect(terminal.locator('[data-operator-engine-walkthrough-target="operator"]')).toBeVisible()
      await page.getByLabel("Open application sidebar").click()
      await expect(page.locator('[data-bento-palette="true"]')).toBeVisible()
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await page.setViewportSize({ width: 577, height: 900 })
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(mobileOverflow).toBeLessThanOrEqual(0)
  } finally {
    await page.request.delete(`/api/lanes/${payload.lane.id}`)
    await fs.rm(folder, { recursive: true, force: true })
  }
})
