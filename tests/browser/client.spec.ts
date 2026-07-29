import { expect, test, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import Database from "better-sqlite3"

import {
  ensureTerminalContinuitySchema,
  createTerminalBinding,
  getTerminalBinding,
  setTerminalBindingIdentity,
} from "../../scripts/terminal-binding-store.mjs"
import { signTerminalControlCapability } from "../../scripts/terminal-control-capability.mjs"
import type { TerminalBinding } from "../../lib/types"

type BrowserLane = { id: string; name: string; path: string }
const browserDistribution = process.env.OPERATOR_ENGINE_TEST_DISTRIBUTION ?? "stock"

test.beforeEach(async ({ page }) => {
  if (browserDistribution !== "theme-7") return
  // Playwright loads this spec through CJS; dynamic import selects Theme Seven's ESM-only export.
  const version = (await import("theme-7")).ompTheme7.distribution.onboarding?.version ?? "1"
  await page.addInitScript((version) => {
    const completed = JSON.stringify({ stepId: "intro", completed: true })
    localStorage.setItem(`operator-engine:distribution-onboarding:v1:theme-7:${version}`, completed)
  }, version)
})

function isBrowserLane(value: unknown): value is BrowserLane {
  return value !== null && typeof value === "object"
    && "id" in value && typeof value.id === "string"
    && "name" in value && typeof value.name === "string"
    && "path" in value && typeof value.path === "string"
}

function browserLanes(value: unknown): BrowserLane[] {
  if (!value || typeof value !== "object" || !("lanes" in value) || !Array.isArray(value.lanes) || !value.lanes.every(isBrowserLane)) throw new Error("Lane API returned an invalid browser-test payload.")
  return value.lanes
}

function browserLayoutRevision(value: unknown): number {
  if (!value || typeof value !== "object" || !("layoutRevision" in value)
    || typeof value.layoutRevision !== "number" || !Number.isSafeInteger(value.layoutRevision)) {
    throw new Error("Lane layout API returned an invalid revision.")
  }
  return value.layoutRevision
}

function isBrowserTerminalBinding(value: unknown): value is TerminalBinding {
  return value !== null && typeof value === "object"
    && "paneId" in value && typeof value.paneId === "string"
    && "harnessId" in value && (value.harnessId === "omp" || value.harnessId === "codex" || value.harnessId === "shell")
    && "resumeSessionId" in value && (value.resumeSessionId === null || typeof value.resumeSessionId === "string")
    && "kickoffSent" in value && typeof value.kickoffSent === "boolean"
    && "generation" in value && typeof value.generation === "number" && Number.isSafeInteger(value.generation)
    && "updatedAt" in value && typeof value.updatedAt === "string"
}

function browserTerminalBindings(value: unknown): Record<string, TerminalBinding> {
  if (!value || typeof value !== "object" || !("terminalBindings" in value)
    || !value.terminalBindings || typeof value.terminalBindings !== "object"
    || !Object.values(value.terminalBindings).every(isBrowserTerminalBinding)) {
    throw new Error("Lane layout API returned invalid terminal bindings.")
  }
  return value.terminalBindings as Record<string, TerminalBinding>
}


async function createLaneWithLayout(page: Page, slug: string, tree: unknown): Promise<BrowserLane> {
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const folder = path.join(dataDirectory, "workspace", `${slug}-${Date.now()}`)
  await fs.mkdir(folder, { recursive: true })
  const created = await page.request.post("/api/lanes", {
    data: { path: folder, name: slug, defaultHarness: "shell", existingFolderUnchanged: true },
  })
  const payload: unknown = await created.json()
  expect(created.ok(), JSON.stringify(payload)).toBe(true)
  if (!payload || typeof payload !== "object" || !("lane" in payload) || !isBrowserLane(payload.lane)) {
    throw new Error("Lane API did not return the browser-test lane.")
  }
  const saved = await page.request.patch(`/api/lanes/${payload.lane.id}/layout`, {
    data: { layout: { schemaVersion: 1, tree }, baseRevision: 0 },
  })
  expect(saved.ok()).toBe(true)
  return payload.lane
}


test("switches lanes immediately without a dynamic route round trip", async ({ page }) => {
  const suffix = Date.now().toString(36)
  const tree = {
    kind: "tabs",
    activeId: "files-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { harnessId: "shell", role: "first", kickoffSent: false } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  }
  const first = await createLaneWithLayout(page, `instant-switch-first-${suffix}`, tree)
  const second = await createLaneWithLayout(page, `instant-switch-second-${suffix}`, tree)
  let secondRouteRequests = 0
  await page.route(`**/lanes/${second.id}?*`, async (route) => {
    secondRouteRequests += 1
    const delay = Promise.withResolvers<void>()
    setTimeout(delay.resolve, 3_000)
    await delay.promise
    await route.continue()
  })

  try {
    await page.goto(`/lanes/${first.id}`)
    const secondButton = page.getByRole("button", { name: new RegExp(`Select (work lane|job|project) ${second.name}`) })
    await secondButton.click()

    await expect(page).toHaveURL(new RegExp(`/lanes/${second.id}$`), { timeout: 1_000 })
    await expect(page.locator("header").first()).toContainText(second.name, { timeout: 1_000 })
    expect(secondRouteRequests).toBe(0)

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/lanes/${first.id}$`), { timeout: 1_000 })
    await expect(page.locator("header").first()).toContainText(first.name, { timeout: 1_000 })
  } finally {
    await Promise.all([page.request.delete(`/api/lanes/${first.id}`), page.request.delete(`/api/lanes/${second.id}`)])
    await Promise.all([
      fs.rm(first.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
      fs.rm(second.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    ])
  }
})


test("preserves lane layout and operator theme", async ({ page }) => {
  test.skip(browserDistribution !== "stock", "The stock UI contract runs only for the stock distribution.")
  test.setTimeout(90_000)
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Choose a folder" })).toBeVisible()
  await expect(page.getByText(/Your files stay where they are\./)).toBeVisible()
  await page.getByRole("button", { name: "Choose folder", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("heading", { name: /Choose the folder for this (work lane|job)/ })).toBeVisible()
  await expect(page.getByText("New work lane", { exact: true })).toHaveCount(0)
  await expect(page.getByText("A lane is just a folder on your computer.", { exact: true })).toHaveCount(0)
  await expect(page.getByText(/can work with everything inside it\. Git will be initialized if needed\./)).toBeVisible()
  const workspaceRoot = page.getByRole("dialog").getByLabel("Project root", { exact: true })
  await expect(workspaceRoot).toBeVisible()
  await expect(workspaceRoot.locator("option")).toHaveCount(2)
  expect(await workspaceRoot.locator("option").allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/…[\\/].+[\\/]workspace$/), expect.stringMatching(/…[\\/].+[\\/]workspace-two$/)]))
  const workspaceTwoValue = await workspaceRoot.locator("option").filter({ hasText: "workspace-two" }).getAttribute("value")
  expect(workspaceTwoValue).toBeTruthy()
  await workspaceRoot.selectOption(workspaceTwoValue!)
  const folder = `browser-smoke-${Date.now()}`
  await page.getByRole("button", { name: "New folder" }).click()
  await page.getByPlaceholder("Folder name").fill(folder)
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByRole("button", { name: "Up one folder" })).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: /(Add work lane|Add job)/ }).click()
  await expect(page).toHaveURL(/\/lanes\/[A-Za-z0-9_.-]+$/)
  await expect(page.locator('[data-lane-create-position="list"]')).toBeVisible()
  await expect(page.locator('[data-lane-create-position="rail"]')).toBeVisible()

  await expect(page.getByRole("heading", { name: "Open a terminal" })).toBeVisible()
  await expect(page.getByText("Nothing starts until you open it.", { exact: true })).toBeVisible()
  const readyPane = page.locator('[data-terminal-state="ready"]').first()
  const selectedAgent = page.locator("[data-selected-agent]").first()
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  const lightReadyBackground = await readyPane.evaluate((element) => getComputedStyle(element).backgroundColor)
  const lightSelectedBorder = await selectedAgent.evaluate((element) => getComputedStyle(element).borderTopColor)
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await expect.poll(() => readyPane.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(lightReadyBackground)
  await expect.poll(() => selectedAgent.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(lightSelectedBorder)
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await expect(page.getByRole("radio")).toHaveCount(0)
  await expect(page.getByText("Claude Code", { exact: true })).not.toBeVisible()
  const changeHarness = page.getByRole("button", { name: "Change", exact: true })
  const canChangeHarness = await changeHarness.isVisible()
  if (canChangeHarness) {
    await changeHarness.click()
    await expect(page.getByRole("radio", { name: /Shell/ })).toBeVisible()
    await expect(page.getByText("Claude Code", { exact: true })).not.toBeVisible()
  } else {
    await expect(page.getByText("Shell", { exact: true })).toBeVisible()
  }
  await expect(page.locator('[data-operator-engine-slot="agent-card:codex"]')).toBeVisible()
  await expect(page.locator('[data-operator-engine-slot="agent-card:shell"]')).toBeVisible()
  await expect(page.locator('[data-operator-engine-slot="agent-card:omp"]')).toHaveCount(0)
  const harnessSlots = await page.locator("[data-terminal-preflight] [data-operator-engine-slot]").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-operator-engine-slot")))
  expect(harnessSlots).toContain("agent-card:codex")
  if (canChangeHarness) expect(harnessSlots).toContain("agent-card:shell")
  expect(harnessSlots).not.toContain("agent-card:claude-code")
  await expect(page.getByText("Claude Code", { exact: true })).toHaveCount(0)

  const mainTerminalPane = page.locator('[data-pane-id="terminal-main"]')
  await mainTerminalPane.getByLabel("Open Agent terminal menu").click()
  await page.getByRole("menuitem", { name: "Full screen" }).click()
  await expect(mainTerminalPane).toHaveAttribute("data-pane-fullscreen", "true")
  await expect(page.locator('[data-pane-id="files-main"]')).toBeHidden()
  await expect(page.getByLabel("Open pane palette")).toHaveCount(0)
  await mainTerminalPane.getByLabel("Open Agent terminal menu").click()
  await page.getByRole("menuitem", { name: "Exit full screen" }).click()
  await expect(page.locator('[data-pane-id="files-main"]')).toBeVisible()

  await mainTerminalPane.getByLabel("Close pane").click()
  const terminalCloseDialog = page.getByRole("alertdialog", { name: "Close agent terminal?" })
  await expect(terminalCloseDialog).toContainText("Files in this folder stay safe.")
  const closePaneBounds = await mainTerminalPane.boundingBox()
  const closeOverlayBounds = await mainTerminalPane.locator("[data-terminal-close-overlay]").boundingBox()
  const closeDialogBounds = await terminalCloseDialog.boundingBox()
  if (!closePaneBounds || !closeOverlayBounds || !closeDialogBounds) throw new Error("The pane-scoped close dialog did not render.")
  expect(Math.abs(closeOverlayBounds.x - closePaneBounds.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(closeOverlayBounds.y - closePaneBounds.y)).toBeLessThanOrEqual(2)
  expect(Math.abs(closeOverlayBounds.width - closePaneBounds.width)).toBeLessThanOrEqual(2)
  expect(Math.abs(closeOverlayBounds.height - closePaneBounds.height)).toBeLessThanOrEqual(2)
  expect(closeDialogBounds.x).toBeGreaterThanOrEqual(closePaneBounds.x)
  expect(closeDialogBounds.y).toBeGreaterThanOrEqual(closePaneBounds.y)
  expect(closeDialogBounds.x + closeDialogBounds.width).toBeLessThanOrEqual(closePaneBounds.x + closePaneBounds.width)
  expect(closeDialogBounds.y + closeDialogBounds.height).toBeLessThanOrEqual(closePaneBounds.y + closePaneBounds.height)
  await terminalCloseDialog.getByRole("button", { name: "Keep terminal" }).click()
  await expect(mainTerminalPane).toBeVisible()

  await page.getByLabel("Open application sidebar").click()
  await page.getByTitle("Click or drag to add Agent terminal").click()
  let terminalPanes = page.locator('[data-pane-id^="terminal-"]')
  await expect(terminalPanes).toHaveCount(2)
  const mainPaneBounds = await mainTerminalPane.boundingBox()
  expect(mainPaneBounds).not.toBeNull()
  await terminalPanes.nth(1).locator("header").dragTo(mainTerminalPane, { targetPosition: { x: mainPaneBounds!.width / 2, y: mainPaneBounds!.height / 2 } })
  const paneTabs = page.getByRole("tablist", { name: "Pane tabs" })
  await expect(paneTabs.getByRole("tab", { name: "Agent terminal" })).toHaveCount(2)
  await paneTabs.getByRole("tab", { name: "Agent terminal" }).first().hover()
  await expect(paneTabs.getByLabel("Close Agent terminal").first()).toHaveCSS("opacity", "1")

  await paneTabs.getByLabel("New agent terminal tab").click()
  await expect(paneTabs.getByRole("tab", { name: "Agent terminal" })).toHaveCount(3)
  await paneTabs.getByLabel("Close Agent terminal").last().click()
  await terminalCloseDialog.getByRole("checkbox", { name: "Don't ask again in this lane" }).check()
  await terminalCloseDialog.getByRole("button", { name: "Close terminal" }).click()
  await expect(paneTabs.getByRole("tab", { name: "Agent terminal" })).toHaveCount(2)

  await paneTabs.getByLabel("Close Agent terminal").last().click()
  await expect(terminalCloseDialog).toHaveCount(0)
  await expect(paneTabs).toHaveCount(0)
  terminalPanes = page.locator('[data-pane-id^="terminal-"]')
  await expect(terminalPanes).toHaveCount(1)
  await page.getByLabel("Close application sidebar").click()
  await page.getByLabel("Close pane").last().click()
  await page.getByLabel("Open application sidebar").click()
  await page.getByTitle("Click or drag to add Files").click()
  await expect(page.getByText("Files", { exact: true }).first()).toBeVisible()

  const panePalette = page.locator('[data-bento-palette="true"]')
  await expect(panePalette.getByRole("tab")).toHaveCount(0)
  await expect(panePalette.getByTitle("Click or drag to add Agent terminal")).toBeVisible()
  await expect(panePalette.getByTitle("Click or drag to add Files")).toBeVisible()
  await expect(panePalette.getByTitle("Click or drag to add Browser")).toBeVisible()
  await expect(panePalette.getByTitle(/Activity/i)).toHaveCount(0)
  await expect(panePalette.getByTitle(/Session History/i)).toHaveCount(0)

  const paletteDragSource = page.getByTitle("Click or drag to add Agent terminal")
  const paletteDragTarget = page.locator("[data-pane-id]").last()
  await paletteDragSource.dragTo(paletteDragTarget, { targetPosition: { x: 8, y: 120 } })
  terminalPanes = page.locator('[data-pane-id^="terminal-"]')
  await expect(terminalPanes).toHaveCount(2)

  const removedPromptPresetRoute = await page.request.get("/api/kits")
  expect(removedPromptPresetRoute.status()).toBe(404)

  await page.getByLabel("Close application sidebar").click()
  await page.getByLabel("Open application sidebar").click()
  await expect(page.getByTitle("Click or drag to add Files")).toBeVisible()

  await expect(page.getByText("Current product", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("aria-expanded", "false")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Dark" }).click()
  await expect(page.locator("html")).toHaveClass(/dark/)

})

test("opens and restores a lane-local static site through a terminal capability and Files", async ({ page }) => {
  test.setTimeout(90_000)
  const localSite = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><title>Local app</title><p id=local-app>${request.url}</p>`)
  })
  await new Promise<void>((resolve) => localSite.listen(0, "127.0.0.1", resolve))
  const address = localSite.address()
  if (!address || typeof address === "string") throw new Error("Local Browser fixture did not start.")
  const localUrl = `http://127.0.0.1:${address.port}`
  await page.goto("/")
  const stockOnboardingAction = page.getByRole("button", { name: "Choose folder", exact: true })
  if (await stockOnboardingAction.isVisible()) await stockOnboardingAction.click()
  else await page.getByRole("button", { name: /(Add work lane|Add job)/ }).last().click()
  const webPreviewRoot = page.getByRole("dialog").getByLabel("Project root", { exact: true })
  const webPreviewRootValue = await webPreviewRoot.locator("option").filter({ hasText: "workspace-two" }).getAttribute("value")
  expect(webPreviewRootValue).toBeTruthy()
  await webPreviewRoot.selectOption(webPreviewRootValue!)
  const folder = `web-preview-${Date.now()}`
  await page.getByRole("button", { name: "New folder" }).click()
  await page.getByPlaceholder("Folder name").fill(folder)
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: /(Add work lane|Add job)/ }).click()

  let lane: BrowserLane | undefined
  await expect.poll(async () => {
    const lanesResponse = await page.request.get(`/api/lanes?fresh=${Date.now()}`, { headers: { "cache-control": "no-cache" } })
    const lanesPayload: unknown = await lanesResponse.json()
    lane = browserLanes(lanesPayload).find((candidate) => candidate.name === folder)
    return lane?.id
  }).not.toBeUndefined()
  expect(lane).toBeTruthy()
  await expect(page).toHaveURL(new RegExp(`/lanes/${lane!.id}$`))
  const demo = path.join(lane!.path, "demo")
  await fs.mkdir(demo, { recursive: true })
  await fs.writeFile(path.join(demo, "style.css"), "body { color: rgb(12, 110, 80); font-family: sans-serif }", "utf8")
  await fs.writeFile(path.join(demo, "app.js"), "document.querySelector('#action').addEventListener('click', () => document.querySelector('#message').textContent = 'Clicked')", "utf8")
  await fs.writeFile(path.join(demo, "module.mjs"), "document.body.dataset.module = 'ready'", "utf8")
  await fs.writeFile(path.join(demo, "index.html"), `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><p id="message">Version one</p><button id="action">Act</button><script src="./app.js"></script><script type="module" src="./module.mjs"></script><script>fetch("https://example.invalid/").catch(() => document.body.dataset.network = "blocked")</script></body></html>`, "utf8")

  await expect(page.locator('iframe[title^="Browser:"]')).toHaveCount(0)
  const changeHarness = page.getByRole("button", { name: "Change", exact: true })
  if (await changeHarness.isVisible()) {
    await changeHarness.click()
    await page.getByRole("radio", { name: /Shell/ }).click()
  }
  await expect(page.getByRole("button", { name: "Open Shell in this folder" })).toBeEnabled()
  await page.getByRole("button", { name: "Open Shell in this folder" }).click()
  const terminalInput = page.locator(".xterm-helper-textarea")
  await expect(terminalInput).toBeAttached()
  await expect.poll(() => page.locator(".xterm-rows").textContent(), { timeout: 10_000 }).toMatch(/attached in|PS .+>/)
  await terminalInput.focus()
  await terminalInput.evaluate((element) => (element as HTMLTextAreaElement).blur())
  const routedPasteWasClaimed = await page.evaluate(() => {
    const clipboard = new DataTransfer()
    clipboard.setData("text/plain", "DICTATION_PASTE_BRIDGE")
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard })
    document.body.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(routedPasteWasClaimed).toBe(true)
  await expect.poll(() => page.locator(".xterm-rows").textContent()).toContain("DICTATION_PASTE_BRIDGE")
  await page.evaluate(() => {
    const input = document.createElement("input")
    input.dataset.testid = "editable-paste-target"
    document.body.append(input)
  })
  const editablePasteTarget = page.getByTestId("editable-paste-target")
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin })
  await page.evaluate(() => navigator.clipboard.writeText("EDITABLE_PASTE_RETAINED"))
  await editablePasteTarget.focus()
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V")
  await expect(editablePasteTarget).toHaveValue("EDITABLE_PASTE_RETAINED")
  await expect(page.locator(".xterm-rows")).not.toContainText("EDITABLE_PASTE_RETAINED")
  await editablePasteTarget.evaluate((element) => element.remove())
  await terminalInput.focus()
  await page.keyboard.press("Control+C")
  await terminalInput.focus()
  await page.keyboard.type("operator-engine open demo/index.html")
  await page.keyboard.press("Enter")

  const frame = page.frameLocator('iframe[title="Browser: demo/index.html"]')
  await expect(page.getByLabel("Browser address")).toHaveValue("demo/index.html")
  await expect(frame.locator("#message")).toHaveText("Version one")
  await expect(frame.locator("body")).toHaveCSS("color", "rgb(12, 110, 80)")
  await expect(frame.locator("body")).toHaveAttribute("data-module", "ready")
  await expect(frame.locator("body")).toHaveAttribute("data-network", "blocked")
  await frame.getByRole("button", { name: "Act" }).click()
  await expect(frame.locator("#message")).toHaveText("Clicked")

  const resizeHandle = page.getByRole("button", { name: "Resize panes" }).first()
  const leftPane = page.locator("[data-pane-id]").first()
  const [handleBox, iframeBox, leftBefore] = await Promise.all([resizeHandle.boundingBox(), page.locator('iframe[title="Browser: demo/index.html"]').boundingBox(), leftPane.boundingBox()])
  expect(handleBox).toBeTruthy()
  expect(iframeBox).toBeTruthy()
  expect(leftBefore).toBeTruthy()
  const resizeY = iframeBox!.y + iframeBox!.height / 2
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, resizeY)
  await page.mouse.down()
  await expect(page.locator("[data-pane-resize-shield]")).toBeVisible()
  await page.mouse.move(iframeBox!.x + Math.min(160, iframeBox!.width / 3), resizeY, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator("[data-pane-resize-shield]")).toHaveCount(0)
  const leftAfter = await leftPane.boundingBox()
  expect(leftAfter).toBeTruthy()
  expect(leftAfter!.width).toBeGreaterThan(leftBefore!.width + 80)

  await page.getByLabel("Open application sidebar").click()
  await page.getByTitle("Show existing Browser").click()
  await page.getByLabel("Close application sidebar").click()
  await expect(page.locator('iframe[title^="Browser:"]')).toHaveCount(1)

  await fs.writeFile(path.join(demo, "style.css"), "body { color: rgb(100, 40, 160); font-family: sans-serif }", "utf8")
  await fs.writeFile(path.join(demo, "index.html"), `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><p id="message">Version two</p><script type="module" src="./module.mjs"></script></body></html>`, "utf8")
  await expect(frame.locator("#message")).toHaveText("Version two", { timeout: 8_000 })
  await expect(frame.locator("body")).toHaveCSS("color", "rgb(100, 40, 160)")

  await expect(page.locator(".xterm-rows")).toContainText(/Opened demo\/index\.html in Browser\.[\s\S]*PS .+>/, { timeout: 10_000 })
  await expect(page.getByRole("button", { name: "index.html" })).toBeVisible({ timeout: 8_000 })
  await page.getByRole("button", { name: "index.html" }).click()
  await terminalInput.focus()
  await page.keyboard.type(`operator-engine open ${localUrl}/agent`)
  await page.keyboard.press("Enter")
  await expect(page.getByLabel("Browser address")).toHaveValue(`${localUrl}/agent`, { timeout: 10_000 })
  await expect(page.frameLocator(`iframe[title="Browser: ${localUrl}/agent"]`).locator("#local-app")).toHaveText("/agent", { timeout: 10_000 })

  await page.getByLabel("Browser address").fill(`${localUrl}/manual`)
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(page.frameLocator(`iframe[title="Browser: ${localUrl}/manual"]`).locator("#local-app")).toHaveText("/manual")

  await expect(page.getByRole("button", { name: "Open in Browser" })).toBeVisible()
  await page.getByRole("button", { name: "Open in Browser" }).click()
  await expect(frame.locator("#message")).toHaveText("Version two")
  await page.waitForTimeout(500)

  await page.reload()
  await expect(page).toHaveURL(new RegExp(`/lanes/${lane!.id}$`))
  await expect(page.locator(".xterm-helper-textarea")).toBeAttached({ timeout: 10_000 })
  await expect.poll(() => page.locator(".xterm-rows").textContent(), { timeout: 10_000 }).toMatch(/attached in|operator-engine open demo\/index\.html/)
  await expect(page.frameLocator('iframe[title="Browser: demo/index.html"]').locator("#message")).toHaveText("Version two")
  await fs.unlink(path.join(demo, "index.html"))
  const unavailable = page.locator('[data-browser-source-state="unavailable"]')
  await expect(unavailable).toBeVisible({ timeout: 8_000 })
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  const lightUnavailableBackground = await unavailable.evaluate((element) => getComputedStyle(element).backgroundColor)
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await expect.poll(() => unavailable.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(lightUnavailableBackground)

  const relaySessions = async (): Promise<number> => {
    const port = process.env.OPERATOR_ENGINE_TEST_TERMINAL_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_TERMINAL_PORT ?? "4401"
    const value: unknown = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()
    if (!value || typeof value !== "object" || !("sessions" in value) || typeof value.sessions !== "number") throw new Error("Relay health returned an invalid browser-test payload.")
    return value.sessions
  }
  const sessionsBeforeDelete = await relaySessions()
  expect(sessionsBeforeDelete).toBeGreaterThan(0)
  await page.getByLabel(/Open (work lane|job) settings/).click()
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: /Remove (work lane|job)/ }).click()
  await expect(page).not.toHaveURL(new RegExp(`/lanes/${lane!.id}$`))
  await expect.poll(relaySessions).toBe(Math.max(0, sessionsBeforeDelete - 1))
  await expect.poll(async () => fs.stat(lane!.path).then(() => true, () => false)).toBe(true)
  await new Promise<void>((resolve, reject) => localSite.close((error) => error ? reject(error) : resolve()))
})

test("closes its scoped Agent Terminal after the terminal command is accepted", async ({ page }) => {
  test.skip(browserDistribution !== "stock", "The terminal close command smoke uses the stock Shell harness.")
  await page.setViewportSize({ width: 1280, height: 900 })
  const lane = await createLaneWithLayout(page, "agent-terminal-close", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { harnessId: "shell", role: "first", kickoffSent: false } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    const terminalPane = page.locator('[data-pane-id="terminal-main"]')
    const filesPane = page.locator('[data-pane-id="files-main"]')
    await expect(terminalPane).toBeVisible()
    await terminalPane.getByRole("button", { name: "Open Shell in this folder" }).click()
    const terminalInput = terminalPane.locator(".xterm-helper-textarea")
    await expect(terminalInput).toBeAttached()
    await expect.poll(() => terminalPane.locator(".xterm-rows").textContent(), { timeout: 10_000 }).toMatch(/attached in|PS .+>/)
    await terminalInput.focus()
    await page.keyboard.type("operator-engine close")
    await page.keyboard.press("Enter")

    await expect(terminalPane).toHaveCount(0, { timeout: 10_000 })
    await expect(page.getByRole("alertdialog", { name: "Close agent terminal?" })).toHaveCount(0)
    await expect(filesPane).toBeVisible()
    const persisted = await page.request.get(`/api/lanes/${lane.id}/layout`)
    expect(persisted.ok()).toBe(true)
    const persistedBody = JSON.stringify(await persisted.json())
    expect(persistedBody).not.toContain("terminal-main")
    expect(persistedBody).toContain("files-main")
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("keeps a sole Agent Terminal when the terminal close command is rejected", async ({ page }) => {
  test.skip(browserDistribution !== "stock", "The terminal close command smoke uses the stock Shell harness.")
  await page.setViewportSize({ width: 577, height: 900 })
  const lane = await createLaneWithLayout(page, "sole-agent-terminal-close", {
    kind: "pane",
    id: "terminal-main",
    pane: "terminal",
    config: { harnessId: "shell", role: "first", kickoffSent: false },
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    const terminalPane = page.locator('[data-pane-id="terminal-main"]')
    await terminalPane.getByRole("button", { name: "Open Shell in this folder" }).click()
    const terminalInput = terminalPane.locator(".xterm-helper-textarea")
    await expect(terminalInput).toBeAttached()
    await expect.poll(() => terminalPane.locator(".xterm-rows").textContent(), { timeout: 10_000 }).toMatch(/attached in|PS .+>/)
    await terminalInput.focus()
    await page.keyboard.type("operator-engine close")
    await page.keyboard.press("Enter")

    await expect(terminalPane.locator(".xterm-rows")).toContainText("operator-engine: This Agent Terminal is the only pane in the lane.", { timeout: 10_000 })
    await expect(terminalPane).toBeVisible()
    await expect(page.getByRole("alertdialog", { name: "Close agent terminal?" })).toHaveCount(0)
    const persisted = await page.request.get(`/api/lanes/${lane.id}/layout`)
    expect(JSON.stringify(await persisted.json())).toContain("terminal-main")
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})


test("keeps a closed live terminal removed when a stale server layout arrives", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "Live OMP layout races belong to Theme Seven.")
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const folder = path.join(dataDirectory, "workspace", `close-live-terminal-${Date.now()}`)
  await fs.mkdir(folder, { recursive: true })

  const created = await page.request.post("/api/lanes", {
    data: { path: folder, name: "Close live terminal smoke", defaultHarness: "omp", existingFolderUnchanged: true },
  })
  const payload: unknown = await created.json()
  expect(created.ok(), JSON.stringify(payload)).toBe(true)
  if (!payload || typeof payload !== "object" || !("lane" in payload) || !isBrowserLane(payload.lane)) throw new Error("Lane API did not return the close-live-terminal smoke lane.")
  const lane = payload.lane
  const layout = {
    schemaVersion: 1 as const,
    tree: {
      kind: "tabs" as const,
      activeId: "terminal-main",
      panes: [
        { kind: "pane" as const, id: "terminal-main", pane: "terminal", config: { harnessId: "omp", role: "first", kickoffSent: true } },
        { kind: "pane" as const, id: "files-main", pane: "files" },
      ],
    },
  }
  const saved = await page.request.patch(`/api/lanes/${lane.id}/layout`, { data: { layout, baseRevision: 0 } })
  expect(saved.ok()).toBe(true)
  const savedState = await saved.json() as {
    layoutRevision: number
    layout: typeof layout
    terminalBindings: Record<string, TerminalBinding>
  }
  const liveBinding = savedState.terminalBindings["terminal-main"]
  if (!liveBinding) throw new Error("The close-live-terminal fixture has no durable binding.")

  let reportStaleLayoutRequested: () => void = () => undefined
  const staleLayoutRequested = new Promise<void>((resolve) => { reportStaleLayoutRequested = resolve })
  let releaseStaleLayout: () => void = () => undefined
  const staleLayoutRelease = new Promise<void>((resolve) => { releaseStaleLayout = resolve })
  await page.route(`**/api/lanes/${lane.id}/layout`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue()
      return
    }
    reportStaleLayoutRequested()
    await staleLayoutRelease
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...savedState, layout }),
    })
  })
  await page.route("**/api/terminal-ticket", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticket: "close-live-terminal-smoke",
        binding: liveBinding,
        mode: "attach",
        guidanceIncluded: false,
      }),
    })
  })
  await page.addInitScript(({ generation }) => {
    class LiveTerminalSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readyState = LiveTerminalSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      constructor() {
        setTimeout(() => {
          this.readyState = LiveTerminalSocket.OPEN
          this.onopen?.(new Event("open"))
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
            kind: "started",
            generation,
            kickoffSent: true,
          }) }))
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
            kind: "session",
            generation,
            title: "Live OMP session",
          }) }))
        }, 0)
      }

      send() {}
      close() {
        this.readyState = LiveTerminalSocket.CLOSED
        this.onclose?.(new CloseEvent("close", { code: 1000 }))
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: LiveTerminalSocket })
  }, { generation: liveBinding.generation })

  try {
    await page.goto(`/lanes/${lane.id}`)
    await expect(page.getByRole("tab", { name: "Live OMP session" })).toBeVisible({ timeout: 10_000 })
    await page.evaluate(({ laneId, layoutRevision }) => {
      const channel = new BroadcastChannel(`operator-engine:lane-layout:v1:${laneId}`)
      channel.postMessage({ kind: "layout", layoutRevision })
      window.setTimeout(() => channel.close(), 1_000)
    }, { laneId: lane.id, layoutRevision: savedState.layoutRevision + 1 })
    await staleLayoutRequested

    await page.getByLabel("Close Live OMP session").click()
    await page.getByRole("alertdialog", { name: "Close agent terminal?" }).getByRole("button", { name: "Close terminal" }).click()
    await expect(page.locator('[data-pane-id="terminal-main"]')).toHaveCount(0)

    releaseStaleLayout()
    await expect(page.locator('[data-pane-id="terminal-main"]')).toHaveCount(0)
    await page.waitForTimeout(500)
    await expect(page.locator('[data-pane-id="terminal-main"]')).toHaveCount(0)
  } finally {
    releaseStaleLayout()
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test("promotes a live OMP session title into its tab and pane header", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "OMP session promotion belongs to Theme Seven.")
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const folder = path.join(dataDirectory, "workspace", `session-title-${Date.now()}`)
  await fs.mkdir(folder, { recursive: true })

  const created = await page.request.post("/api/lanes", {
    data: { path: folder, name: "Session title smoke", defaultHarness: "omp", existingFolderUnchanged: true },
  })
  const payload: unknown = await created.json()
  expect(created.ok(), JSON.stringify(payload)).toBe(true)
  if (!payload || typeof payload !== "object" || !("lane" in payload) || !isBrowserLane(payload.lane)) throw new Error("Lane API did not return the session-title smoke lane.")
  const lane = payload.lane
  const layout = {
    schemaVersion: 1 as const,
    tree: {
      kind: "tabs" as const,
      activeId: "terminal-main",
      panes: [
        { kind: "pane" as const, id: "terminal-main", pane: "terminal", config: { harnessId: "omp", role: "first", kickoffSent: false } },
        { kind: "pane" as const, id: "files-main", pane: "files" },
      ],
    },
  }
  const saved = await page.request.patch(`/api/lanes/${lane.id}/layout`, { data: { layout, baseRevision: 0 } })
  expect(saved.ok()).toBe(true)
  const savedState = await saved.json() as { terminalBindings: Record<string, TerminalBinding> }
  const initialBinding = savedState.terminalBindings["terminal-main"]
  if (!initialBinding) throw new Error("The session-title fixture has no durable binding.")

  let newSessionRequests = 0
  let mockedBinding = initialBinding
  await page.route("**/api/terminal-ticket", async (route) => {
    const data = route.request().postDataJSON() as { action?: string }
    if (data.action === "new-session") {
      newSessionRequests += 1
      mockedBinding = {
        ...mockedBinding,
        resumeSessionId: null,
        kickoffSent: false,
        generation: mockedBinding.generation + 1,
        updatedAt: new Date().toISOString(),
      }
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticket: "session-title-smoke",
        binding: mockedBinding,
        mode: data.action === "attach" ? "attach" : "start",
        guidanceIncluded: false,
      }),
    })
  })
  await page.addInitScript(({ initialGeneration }) => {
    class SessionSocket {
      static created = 0
      readonly sequence = ++SessionSocket.created
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readyState = SessionSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      constructor() {
        setTimeout(() => {
          const generation = this.sequence === 1 ? initialGeneration : initialGeneration + 1
          this.readyState = SessionSocket.OPEN
          this.onopen?.(new Event("open"))
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
            kind: "started",
            generation,
            kickoffSent: false,
          }) }))
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
            kind: "session",
            generation,
            title: this.sequence === 1 ? "Promoted OMP session" : "Fresh OMP session",
          }) }))
        }, 0)
      }

      send() {}
      close() {
        this.readyState = SessionSocket.CLOSED
        this.onclose?.(new CloseEvent("close", { code: 1000 }))
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: SessionSocket })
  }, { initialGeneration: initialBinding.generation })

  try {
    await page.goto(`/lanes/${lane.id}`)
    await expect(page.getByRole("tab", { name: "Promoted OMP session" })).toBeVisible({ timeout: 10_000 })

    const terminalPane = page.locator('[data-pane-id="terminal-main"]')
    await expect(terminalPane.locator("header").getByText("Promoted OMP session", { exact: true })).toBeVisible()
    await terminalPane.getByLabel("Open Agent terminal menu").click()
    await page.getByRole("menuitem", { name: "Start new session" }).click()
    const newSessionDialog = page.getByRole("alertdialog", { name: "Start a new session?" })
    await expect(newSessionDialog).toContainText("stops any running command")
    await expect(newSessionDialog).toContainText("Files in this folder stay safe.")
    const paneBounds = await terminalPane.boundingBox()
    const overlayBounds = await terminalPane.locator("[data-terminal-new-session-overlay]").boundingBox()
    const dialogBounds = await newSessionDialog.boundingBox()
    if (!paneBounds || !overlayBounds || !dialogBounds) throw new Error("The pane-scoped new-session dialog did not render.")
    expect(Math.abs(overlayBounds.x - paneBounds.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(overlayBounds.y - paneBounds.y)).toBeLessThanOrEqual(2)
    expect(Math.abs(overlayBounds.width - paneBounds.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(overlayBounds.height - paneBounds.height)).toBeLessThanOrEqual(2)
    expect(dialogBounds.x).toBeGreaterThanOrEqual(paneBounds.x)
    expect(dialogBounds.y).toBeGreaterThanOrEqual(paneBounds.y)
    expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(paneBounds.x + paneBounds.width)
    expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(paneBounds.y + paneBounds.height)
    await newSessionDialog.getByRole("button", { name: "Keep current session" }).click()
    expect(newSessionRequests).toBe(0)

    await terminalPane.getByLabel("Open Agent terminal menu").click()
    await page.getByRole("menuitem", { name: "Start new session" }).click()
    await newSessionDialog.getByRole("button", { name: "Start new session" }).click()
    await expect.poll(() => newSessionRequests).toBe(1)
    await expect(page.getByRole("tab", { name: "Fresh OMP session" })).toBeVisible({ timeout: 10_000 })
    await expect(terminalPane.locator("header").getByText("Fresh OMP session", { exact: true })).toBeVisible()

    await terminalPane.getByLabel("Close pane").click()
    const scopedCloseDialog = page.getByRole("alertdialog", { name: "Close agent terminal?" })
    const scopedClosePaneBounds = await terminalPane.boundingBox()
    const scopedCloseOverlayBounds = await terminalPane.locator("[data-terminal-close-overlay]").boundingBox()
    const scopedCloseDialogBounds = await scopedCloseDialog.boundingBox()
    if (!scopedClosePaneBounds || !scopedCloseOverlayBounds || !scopedCloseDialogBounds) throw new Error("The pane-scoped close dialog did not render.")
    expect(Math.abs(scopedCloseOverlayBounds.x - scopedClosePaneBounds.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(scopedCloseOverlayBounds.y - scopedClosePaneBounds.y)).toBeLessThanOrEqual(2)
    expect(Math.abs(scopedCloseOverlayBounds.width - scopedClosePaneBounds.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(scopedCloseOverlayBounds.height - scopedClosePaneBounds.height)).toBeLessThanOrEqual(2)
    expect(scopedCloseDialogBounds.x).toBeGreaterThanOrEqual(scopedClosePaneBounds.x)
    expect(scopedCloseDialogBounds.y).toBeGreaterThanOrEqual(scopedClosePaneBounds.y)
    expect(scopedCloseDialogBounds.x + scopedCloseDialogBounds.width).toBeLessThanOrEqual(scopedClosePaneBounds.x + scopedClosePaneBounds.width)
    expect(scopedCloseDialogBounds.y + scopedCloseDialogBounds.height).toBeLessThanOrEqual(scopedClosePaneBounds.y + scopedClosePaneBounds.height)
    await scopedCloseDialog.getByRole("button", { name: "Keep terminal" }).click()
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test("manages the selected lane from its header without deleting the folder", async ({ page }) => {
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const folder = path.join(dataDirectory, "workspace", `lane-settings-${Date.now()}`)
  await fs.mkdir(folder, { recursive: true })

  const created = await page.request.post("/api/lanes", {
    data: { path: folder, name: "Lane settings before", defaultHarness: "shell", existingFolderUnchanged: true },
  })
  const payload: unknown = await created.json()
  expect(created.ok(), JSON.stringify(payload)).toBe(true)
  if (!payload || typeof payload !== "object" || !("lane" in payload) || !isBrowserLane(payload.lane)) throw new Error("Lane API did not return the settings smoke lane.")
  const lane = payload.lane
  const updatedDefault = browserDistribution === "theme-7" ? "omp" : "codex"

  try {
    await page.goto(`/lanes/${lane.id}`)
    await page.getByLabel(/Open (work lane|job) settings/).click()
    const dialog = page.getByRole("dialog", { name: /(Work lane|Job) settings/ })
    const saveLane = dialog.getByRole("button", { name: /Save (work lane|job)/ })
    await expect(saveLane).toBeEnabled()
    await dialog.getByRole("textbox", { name: "Name" }).fill("Lane settings after")
    await dialog.getByRole("textbox", { name: /(Work lane|Job) note/ }).fill("Resume with the browser preview.")
    await dialog.getByRole("combobox", { name: "Default operator" }).selectOption(updatedDefault)
    await saveLane.click()
    await expect(page.locator("header").getByText(/Lane settings after/)).toBeVisible()
    const settingsResponse = await page.request.get(`/api/lanes/${lane.id}`)
    const settings: unknown = await settingsResponse.json()
    expect(settingsResponse.ok(), JSON.stringify(settings)).toBe(true)
    expect(settings).toMatchObject({
      note: "Resume with the browser preview.",
      lane: { id: lane.id, name: "Lane settings after", defaultHarness: updatedDefault },
    })
    await expect.poll(() => fs.readFile(path.join(folder, "LANE.md"), "utf8")).toBe("Resume with the browser preview.\n")

    await page.getByLabel(/Open (work lane|job) settings/).click()
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Lane settings after")
    await expect(dialog.getByRole("textbox", { name: /(Work lane|Job) note/ })).toHaveValue("Resume with the browser preview.")
    await expect(dialog.getByRole("button", { name: "Attach local session" })).toHaveCount(0)
    await dialog.getByRole("button", { name: "Cancel" }).click()

    await page.getByLabel(/Open (work lane|job) settings/).click()
    page.once("dialog", (confirmation) => confirmation.accept())
    await dialog.getByRole("button", { name: /Remove (work lane|job)/ }).click()
    await expect(page).not.toHaveURL(new RegExp(`/lanes/${lane.id}$`))
    await expect.poll(() => fs.readFile(path.join(folder, "LANE.md"), "utf8")).toBe("Resume with the browser preview.\n")
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test("expands the working tree by dragging its divider upward", async ({ page }) => {
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const folder = path.join(dataDirectory, "workspace", `working-tree-resize-${Date.now()}`)
  await fs.mkdir(folder, { recursive: true })

  const created = await page.request.post("/api/lanes", {
    data: { path: folder, name: "Working tree resize smoke", defaultHarness: "shell", existingFolderUnchanged: true },
  })
  const payload: unknown = await created.json()
  expect(created.ok(), JSON.stringify(payload)).toBe(true)
  if (!payload || typeof payload !== "object" || !("lane" in payload) || !isBrowserLane(payload.lane)) throw new Error("Lane API did not return the working-tree resize lane.")
  const lane = payload.lane

  try {
    const initialResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
    const initial = await initialResponse.json() as {
      layoutRevision: number
      terminalBindings: Record<string, TerminalBinding>
    }
    expect(initialResponse.ok(), JSON.stringify(initial)).toBe(true)
    const terminal = Object.entries(initial.terminalBindings)[0]
    if (!terminal) throw new Error("The working-tree fixture has no terminal binding to close.")
    const closed = await page.request.delete(`/api/lanes/${lane.id}/panes/${terminal[0]}`, {
      data: {
        baseRevision: initial.layoutRevision,
        expectedGeneration: terminal[1].generation,
      },
    })
    expect(closed.ok(), await closed.text()).toBe(true)
    await page.route(`**/api/lanes/${lane.id}/tree`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tree: [{ name: "README.md", relativePath: "README.md", kind: "file" }],
          git: { available: true, branch: "main", lines: ["M README.md", "M package.json", "?? notes.txt"] },
        }),
      })
    })

    await page.goto(`/lanes/${lane.id}`)
    const skipWalkthrough = page.getByRole("button", { name: "Skip walkthrough" })
    if (await skipWalkthrough.isVisible()) await skipWalkthrough.click()

    const resizer = page.getByRole("button", { name: "Resize working tree" })
    const panel = page.locator("[data-working-tree-panel]")
    await expect(resizer).toHaveCSS("cursor", "row-resize")
    await expect(panel).toBeVisible()
    const initialPanel = await panel.boundingBox()
    const handle = await resizer.boundingBox()
    expect(initialPanel).not.toBeNull()
    expect(handle).not.toBeNull()

    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2 - 80, { steps: 5 })
    await page.mouse.up()

    await expect.poll(async () => (await panel.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(initialPanel!.height + 70)
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(folder, { recursive: true, force: true })
  }
})

async function createOmpFilesLane(page: Page, slug: string): Promise<BrowserLane> {
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const folder = path.join(dataDirectory, "workspace", `${slug}-${Date.now()}`)
  await fs.mkdir(folder, { recursive: true })
  const created = await page.request.post("/api/lanes", {
    data: { path: folder, name: slug, defaultHarness: "omp", existingFolderUnchanged: true },
  })
  const payload: unknown = await created.json()
  expect(created.ok(), JSON.stringify(payload)).toBe(true)
  if (!payload || typeof payload !== "object" || !("lane" in payload) || !isBrowserLane(payload.lane)) {
    throw new Error("Lane API did not return the OMP continuity lane.")
  }
  const initialResponse = await page.request.get(`/api/lanes/${payload.lane.id}/layout`)
  const initial = await initialResponse.json() as {
    layoutRevision: number
    terminalBindings: Record<string, { generation: number }>
  }
  expect(initialResponse.ok(), JSON.stringify(initial)).toBe(true)
  const terminal = Object.entries(initial.terminalBindings)[0]
  if (terminal) {
    const closed = await page.request.delete(`/api/lanes/${payload.lane.id}/panes/${terminal[0]}`, {
      data: { baseRevision: initial.layoutRevision, expectedGeneration: terminal[1].generation },
    })
    expect(closed.ok(), JSON.stringify(await closed.json())).toBe(true)
  }
  return payload.lane
}
async function createOmpTerminalLane(page: Page, slug: string): Promise<BrowserLane> {
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const folder = path.join(dataDirectory, "workspace", `${slug}-${Date.now()}`)
  await fs.mkdir(folder, { recursive: true })
  const created = await page.request.post("/api/lanes", {
    data: { path: folder, name: slug, defaultHarness: "omp", existingFolderUnchanged: true },
  })
  const payload: unknown = await created.json()
  expect(created.ok(), JSON.stringify(payload)).toBe(true)
  if (!payload || typeof payload !== "object" || !("lane" in payload) || !isBrowserLane(payload.lane)) {
    throw new Error("Lane API did not return the bound OMP continuity lane.")
  }
  return payload.lane
}

function bindExactOmpSession(laneId: string, paneId: string, sessionId: string) {
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const db = new Database(path.join(dataDirectory, "operator-engine.sqlite"))
  try {
    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")
    if (!ensureTerminalContinuitySchema(db)) throw new Error("Browser continuity database schema is not ready.")
    const binding = getTerminalBinding(db, laneId, paneId)
    if (!binding) throw new Error("Browser continuity lane has no terminal binding.")
    const updated = setTerminalBindingIdentity(db, {
      laneId,
      paneId,
      generation: binding.generation,
      resumeSessionId: sessionId,
    })
    if (!updated) throw new Error("Browser continuity exact binding update failed.")
    return updated
  } finally {
    db.close()
  }
}

function reserveExactOmpPrewarm(laneId: string, paneId: string, sessionId: string): void {
  const webPort = process.env.OPERATOR_ENGINE_TEST_PORT ?? process.env.OPERATOR_ENGINE_BROWSER_PORT ?? "4400"
  const dataDirectory = process.env.OPERATOR_ENGINE_TEST_DATA_DIR ?? path.join(process.cwd(), `.test-data-${webPort}`)
  const db = new Database(path.join(dataDirectory, "operator-engine.sqlite"))
  try {
    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")
    if (!ensureTerminalContinuitySchema(db)) throw new Error("Browser continuity database schema is not ready.")
    const binding = createTerminalBinding(db, { laneId, paneId, harnessId: "omp" })
    if (!binding || binding === "epoch-conflict") throw new Error("Browser continuity prewarm binding creation failed.")
    const updated = setTerminalBindingIdentity(db, {
      laneId,
      paneId,
      generation: binding.generation,
      resumeSessionId: sessionId,
    })
    if (!updated) throw new Error("Browser continuity prewarm identity update failed.")
  } finally {
    db.close()
  }
}


function prewarmBinding(paneId: string, generation = 1, resumeSessionId: string | null = null) {
  return {
    paneId,
    harnessId: "omp",
    resumeSessionId,
    kickoffSent: false,
    generation,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

test("terminal continuity: mounts a provisional OMP pane only after its layout PATCH commits", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "OMP prewarm continuity belongs to Theme Seven.")
  const lane = await createOmpFilesLane(page, "gated-prewarm-insert")
  let prewarmDeletes = 0
  const patchObserved = Promise.withResolvers<void>()
  const patchRelease = Promise.withResolvers<void>()
  let provisionalPaneId = ""
  let staleLayoutPatches = 0
  await page.route("**/api/terminal-prewarm", async (route) => {
    const body = route.request().postDataJSON() as { paneId?: string }
    if (route.request().method() === "DELETE") {
      prewarmDeletes += 1
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cancelled: true }) })
      return
    }
    provisionalPaneId = body.paneId ?? ""
    reserveExactOmpPrewarm(lane.id, provisionalPaneId, "omp-session:early-prewarm")
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, expiresAt: Date.now() + 45_000, binding: prewarmBinding(provisionalPaneId, 1, "omp-session:early-prewarm") }),
    })
  })
  await page.route(`**/api/lanes/${lane.id}/layout`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue()
      return
    }
    if (!JSON.stringify(route.request().postDataJSON()).includes("terminal-")) {
      staleLayoutPatches += 1
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "stale edit escaped insertion barrier" }) })
      return
    }
    patchObserved.resolve()
    await patchRelease.promise
    await route.continue()
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    await expect.poll(() => provisionalPaneId).toMatch(/^terminal-/)
    const openSidebar = page.getByLabel("Open application sidebar")
    if (await openSidebar.isVisible()) await openSidebar.click()
    await page.getByTitle("Click or drag to add Agent terminal").click()
    await patchObserved.promise
    expect(provisionalPaneId).toMatch(/^terminal-/)
    await expect(page.locator(`[data-pane-id="${provisionalPaneId}"]`)).toHaveCount(0)
    await page.getByTitle("Click or drag to add Browser").click()
    await expect(page.getByText("A terminal addition is still being saved.")).toBeVisible()
    expect(staleLayoutPatches).toBe(0)

    patchRelease.resolve()
    await expect(page.locator(`[data-pane-id="${provisionalPaneId}"]`)).toBeVisible()
    expect(prewarmDeletes).toBe(0)
    const persisted = await page.request.get(`/api/lanes/${lane.id}/layout`)
    expect(await persisted.json()).toMatchObject({
      terminalBindings: { [provisionalPaneId]: { generation: 1, harnessId: "omp", resumeSessionId: "omp-session:early-prewarm" } },
    })
  } finally {
    patchRelease.resolve()
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true })
  }
})

for (const outcome of ["conflict", "unknown"] as const) {
  test(`terminal continuity: reconciles a provisional insertion ${outcome} without mounting it`, async ({ page }) => {
    test.skip(browserDistribution !== "theme-7", "OMP prewarm continuity belongs to Theme Seven.")
    const lane = await createOmpFilesLane(page, `gated-prewarm-${outcome}`)
    const canonicalResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
    const canonical = await canonicalResponse.json()
    let prewarmDeletes = 0
    let provisionalPaneId = ""
    await page.route("**/api/terminal-prewarm", async (route) => {
      const body = route.request().postDataJSON() as { paneId?: string }
      if (route.request().method() === "DELETE") {
        prewarmDeletes += 1
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cancelled: true }) })
        return
      }
      provisionalPaneId = body.paneId ?? ""
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, expiresAt: Date.now() + 45_000, binding: prewarmBinding(provisionalPaneId) }),
      })
    })
    await page.route(`**/api/lanes/${lane.id}/layout`, async (route) => {
      if (route.request().method() !== "PATCH" || !JSON.stringify(route.request().postDataJSON()).includes("terminal-")) {
        await route.continue()
        return
      }
      if (outcome === "conflict") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "LAYOUT_CONFLICT", error: "stale", ...canonical }),
        })
      } else {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "response unavailable" }) })
      }
    })

    try {
      await page.goto(`/lanes/${lane.id}`)
      await expect.poll(() => provisionalPaneId).toMatch(/^terminal-/)
      const openSidebar = page.getByLabel("Open application sidebar")
      if (await openSidebar.isVisible()) await openSidebar.click()
      await page.getByTitle("Click or drag to add Agent terminal").click()
      await expect.poll(() => prewarmDeletes).toBe(1)
      await expect(page.locator(`[data-pane-id="${provisionalPaneId}"]`)).toHaveCount(0)
      const persisted = await page.request.get(`/api/lanes/${lane.id}/layout`)
      expect(JSON.stringify(await persisted.json())).not.toContain(provisionalPaneId)
    } finally {
      await page.request.delete(`/api/lanes/${lane.id}`)
      await fs.rm(lane.path, { recursive: true, force: true })
    }
  })
}

test("terminal continuity: losing OMP-default eligibility cancels the exact hidden prewarm", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "OMP prewarm continuity belongs to Theme Seven.")
  const lane = await createOmpFilesLane(page, "prewarm-default-change")
  const deletes: Array<{ laneId?: string; paneId?: string; expectedGeneration?: number }> = []
  let reservedPaneId = ""
  await page.route("**/api/terminal-prewarm", async (route) => {
    const body = route.request().postDataJSON() as { laneId?: string; paneId?: string; expectedGeneration?: number }
    if (route.request().method() === "DELETE") {
      deletes.push(body)
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cancelled: true }) })
      return
    }
    reservedPaneId = body.paneId ?? ""
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, expiresAt: Date.now() + 45_000, binding: prewarmBinding(reservedPaneId, 3) }),
    })
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    await expect.poll(() => reservedPaneId).toMatch(/^terminal-/)
    await page.getByLabel(/Open (work lane|job) settings/).click()
    const dialog = page.getByRole("dialog", { name: /(Work lane|Job) settings/ })
    await dialog.getByRole("combobox", { name: "Default operator" }).selectOption("shell")
    await dialog.getByRole("button", { name: /Save (work lane|job)/ }).click()

    await expect.poll(() => deletes).toEqual([{
      laneId: lane.id,
      paneId: reservedPaneId,
      expectedGeneration: 3,
    }])
    await expect(page.locator(`[data-pane-id="${reservedPaneId}"]`)).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: a canonical terminal supersedes only the exact hidden prewarm", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "OMP prewarm continuity belongs to Theme Seven.")
  const lane = await createOmpFilesLane(page, "prewarm-layout-supersession")
  const deletes: Array<{ laneId?: string; paneId?: string; expectedGeneration?: number }> = []
  let reservedPaneId = ""
  await page.route("**/api/terminal-prewarm", async (route) => {
    const body = route.request().postDataJSON() as { laneId?: string; paneId?: string; expectedGeneration?: number }
    if (route.request().method() === "DELETE") {
      deletes.push(body)
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cancelled: true }) })
      return
    }
    reservedPaneId = body.paneId ?? ""
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, expiresAt: Date.now() + 45_000, binding: prewarmBinding(reservedPaneId, 4) }),
    })
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    await expect.poll(() => reservedPaneId).toMatch(/^terminal-/)
    const beforeResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
    const before = await beforeResponse.json() as {
      layout: { schemaVersion: 1; tree: Record<string, unknown> }
      layoutRevision: number
    }
    expect(beforeResponse.ok(), JSON.stringify(before)).toBe(true)
    const canonicalPaneId = "terminal-canonical"
    const changedResponse = await page.request.patch(`/api/lanes/${lane.id}/layout`, {
      data: {
        baseRevision: before.layoutRevision,
        layout: {
          schemaVersion: 1,
          tree: {
            kind: "split",
            direction: "horizontal",
            percentage: 50,
            first: before.layout.tree,
            second: { kind: "pane", id: canonicalPaneId, pane: "terminal", config: { role: "additional" } },
          },
        },
      },
    })
    const changed = await changedResponse.json() as { layoutRevision?: number }
    expect(changedResponse.ok(), JSON.stringify(changed)).toBe(true)
    expect(changed.layoutRevision).toEqual(expect.any(Number))
    await page.evaluate(({ laneId, layoutRevision }) => {
      const channel = new BroadcastChannel(`operator-engine:lane-layout:v1:${laneId}`)
      channel.postMessage({ kind: "layout", layoutRevision })
      channel.close()
    }, { laneId: lane.id, layoutRevision: changed.layoutRevision! })

    await expect.poll(() => deletes).toEqual([{
      laneId: lane.id,
      paneId: reservedPaneId,
      expectedGeneration: 4,
    }])
    await expect(page.locator(`[data-pane-id="${canonicalPaneId}"]`)).toBeAttached()
    const canonicalResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
    const canonical = await canonicalResponse.json() as { terminalBindings?: Record<string, unknown> }
    expect(canonicalResponse.ok(), JSON.stringify(canonical)).toBe(true)
    expect(Object.keys(canonical.terminalBindings ?? {})).toEqual([canonicalPaneId])
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: unavailable insertion reconciliation retains prewarm until expiry", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "OMP prewarm continuity belongs to Theme Seven.")
  const lane = await createOmpFilesLane(page, "prewarm-reconcile-expiry")
  const renewalRelease = Promise.withResolvers<void>()
  const deletes: Array<{ body: { laneId?: string; paneId?: string; expectedGeneration?: number }; at: number }> = []
  let initialPosts = 0
  let reservedPaneId = ""
  let expiresAt = 0
  let insertionStarted = false
  let failedGets = 0
  await page.route("**/api/terminal-prewarm", async (route) => {
    const body = route.request().postDataJSON() as { laneId?: string; paneId?: string; expectedGeneration?: number }
    if (route.request().method() === "DELETE") {
      deletes.push({ body, at: Date.now() })
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cancelled: true }) })
      return
    }
    if (body.expectedGeneration) {
      await renewalRelease.promise
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "renewal unavailable" }) })
      return
    }
    initialPosts += 1
    if (initialPosts > 1) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ enabled: false }) })
      return
    }
    reservedPaneId = body.paneId ?? ""
    expiresAt = Date.now() + 3_200
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, expiresAt, binding: prewarmBinding(reservedPaneId, 5) }),
    })
  })
  await page.route(`**/api/lanes/${lane.id}/layout`, async (route) => {
    if (route.request().method() === "PATCH" && JSON.stringify(route.request().postDataJSON()).includes("terminal-")) {
      insertionStarted = true
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "response unavailable" }) })
      return
    }
    if (insertionStarted && route.request().method() === "GET") {
      failedGets += 1
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "canonical unavailable" }) })
      return
    }
    await route.continue()
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    await expect.poll(() => reservedPaneId).toMatch(/^terminal-/)
    const openSidebar = page.getByLabel("Open application sidebar")
    if (await openSidebar.isVisible()) await openSidebar.click()
    await page.getByTitle("Click or drag to add Agent terminal").click()
    await expect.poll(() => failedGets).toBeGreaterThan(0)
    await page.waitForTimeout(600)
    expect(Date.now()).toBeLessThan(expiresAt)
    expect(deletes).toEqual([])
    await expect(page.locator(`[data-pane-id="${reservedPaneId}"]`)).toHaveCount(0)

    await expect.poll(() => deletes, { timeout: 8_000 }).toHaveLength(1)
    expect(deletes[0].body).toEqual({
      laneId: lane.id,
      paneId: reservedPaneId,
      expectedGeneration: 5,
    })
    expect(deletes[0].at).toBeGreaterThanOrEqual(expiresAt)
    expect(failedGets).toBeGreaterThanOrEqual(2)
    await expect(page.locator(`[data-pane-id="${reservedPaneId}"]`)).toHaveCount(0)
  } finally {
    renewalRelease.resolve()
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: lane unmount stops renewal without cancelling its reservation", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "OMP prewarm continuity belongs to Theme Seven.")
  const lane = await createOmpFilesLane(page, "prewarm-unmount")
  let prewarmDeletes = 0
  let reservedPaneId = ""
  await page.route("**/api/terminal-prewarm", async (route) => {
    const body = route.request().postDataJSON() as { paneId?: string }
    if (route.request().method() === "DELETE") {
      prewarmDeletes += 1
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cancelled: true }) })
      return
    }
    const paneId = body.paneId ?? ""
    reservedPaneId = paneId
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, expiresAt: Date.now() + 45_000, binding: prewarmBinding(paneId) }),
    })
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    await expect.poll(() => reservedPaneId).toMatch(/^terminal-/)
    await page.goto("/")
    await page.waitForTimeout(500)
    expect(prewarmDeletes).toBe(0)
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true })
  }
})

test("terminal continuity: two pages share one Shell PTY and browser close is detach-only", async ({ page, context }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "two-page-shell-continuity", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const paneDeletes: string[] = []
  page.on("request", (request) => {
    if (request.method() === "DELETE" && /\/api\/lanes\/[^/]+\/panes\//.test(request.url())) paneDeletes.push(request.url())
  })
  const second = await context.newPage()

  try {
    await page.goto(`/lanes/${lane.id}`)
    const firstPane = page.locator('[data-pane-id="terminal-main"]')
    await firstPane.getByRole("button", { name: "Open Shell in this folder" }).click()
    await expect(firstPane.locator('[data-terminal-state="open"]')).toBeVisible({ timeout: 10_000 })

    await second.goto(`/lanes/${lane.id}`)
    const secondPane = second.locator('[data-pane-id="terminal-main"]')
    await expect(secondPane.locator('[data-terminal-state="open"]')).toBeVisible({ timeout: 10_000 })
    await page.close()
    await expect(secondPane.locator('[data-terminal-state="open"]')).toBeVisible()
    const marker = `survivor-${Date.now()}`
    const input = secondPane.locator(".xterm-helper-textarea")
    await input.focus()
    await second.keyboard.type(`echo ${marker}`)
    await second.keyboard.press("Enter")
    await expect(secondPane.locator(".xterm-rows")).toContainText(marker, { timeout: 10_000 })
    expect(paneDeletes).toEqual([])
  } finally {
    await second.request.delete(`/api/lanes/${lane.id}`)
    await second.close()
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: an idle second page joins a later Shell generation", async ({ page, context }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "two-page-later-generation", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const second = await context.newPage()

  try {
    await page.goto(`/lanes/${lane.id}`)
    await second.goto(`/lanes/${lane.id}`)
    const firstPane = page.locator('[data-pane-id="terminal-main"]')
    const secondPane = second.locator('[data-pane-id="terminal-main"]')
    await expect(firstPane.getByRole("button", { name: "Open Shell in this folder" })).toBeVisible()
    await expect(secondPane.getByRole("button", { name: "Open Shell in this folder" })).toBeVisible()

    await firstPane.getByRole("button", { name: "Open Shell in this folder" }).click()
    await expect(firstPane.locator('[data-terminal-state="open"]')).toBeVisible({ timeout: 10_000 })
    await expect(secondPane.locator('[data-terminal-state="open"]')).toBeVisible({ timeout: 10_000 })

    const marker = `later-generation-${Date.now()}`
    await second.bringToFront()
    const input = secondPane.locator(".xterm-helper-textarea")
    await input.focus()
    await second.keyboard.type(`echo ${marker}`)
    await second.keyboard.press("Enter")
    await expect(secondPane.locator(".xterm-rows")).toContainText(marker, { timeout: 10_000 })
    await expect(firstPane.locator(".xterm-rows")).toContainText(marker, { timeout: 10_000 })
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await second.close()
    await page.close()
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 })
  }
})

test("terminal continuity: a delayed attach response cannot replace a newer generation", async ({ page, context }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "delayed-attach-generation", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const initialResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
  const initial: unknown = await initialResponse.json()
  const initialBinding = browserTerminalBindings(initial)["terminal-main"]
  if (!initialBinding) throw new Error("Delayed attach test lane has no terminal binding.")
  const firstAttachObserved = Promise.withResolvers<void>()
  const firstAttachRelease = Promise.withResolvers<void>()
  const firstAttachDelivered = Promise.withResolvers<void>()
  let delayed = false
  await page.route("**/api/terminal-ticket", async (route) => {
    const body: unknown = route.request().postDataJSON()
    const action = body && typeof body === "object" && "action" in body && typeof body.action === "string" ? body.action : ""
    if (action !== "attach" || delayed) {
      await route.continue()
      return
    }
    delayed = true
    firstAttachObserved.resolve()
    await firstAttachRelease.promise
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticket: "stale-generation-ticket",
        mode: "attach",
        guidanceIncluded: false,
        binding: initialBinding,
      }),
    })
    firstAttachDelivered.resolve()
  })
  const second = await context.newPage()

  try {
    await page.goto(`/lanes/${lane.id}`)
    await firstAttachObserved.promise
    await second.goto(`/lanes/${lane.id}`)
    const secondPane = second.locator('[data-pane-id="terminal-main"]')
    await expect(secondPane.getByRole("button", { name: "Open Shell in this folder" })).toBeVisible()
    await secondPane.getByRole("button", { name: "Open Shell in this folder" }).click()
    await expect(secondPane.locator('[data-terminal-state="open"]')).toBeVisible({ timeout: 10_000 })

    const canonicalResponse = await second.request.get(`/api/lanes/${lane.id}/layout`)
    const canonical: unknown = await canonicalResponse.json()
    const newer = browserTerminalBindings(canonical)["terminal-main"]
    if (!newer || newer.generation <= initialBinding.generation) throw new Error("Shell generation did not advance.")
    await page.evaluate(({ laneId, generation }) => {
      const channel = new BroadcastChannel(`operator-engine:lane-layout:v1:${laneId}`)
      channel.postMessage({ kind: "binding", paneId: "terminal-main", bindingGeneration: generation, live: true })
      channel.close()
    }, { laneId: lane.id, generation: newer.generation })

    const firstPane = page.locator('[data-pane-id="terminal-main"]')
    await expect(firstPane.locator('[data-terminal-state="open"]')).toBeVisible({ timeout: 10_000 })
    firstAttachRelease.resolve()
    await firstAttachDelivered.promise

    await page.waitForTimeout(500)
    await expect(firstPane.locator('[data-terminal-state="open"]')).toBeVisible()
  } finally {
    firstAttachRelease.resolve()
    await second.close()
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: a bound OMP pane exact-resumes after attach misses without exposing a picker", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "Bound OMP continuity belongs to Theme Seven.")
  const lane = await createOmpTerminalLane(page, "bound-omp-exact-resume")
  const initialResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
  const initial: unknown = await initialResponse.json()
  const [paneId, initialBinding] = Object.entries(browserTerminalBindings(initial))[0] ?? []
  if (!paneId || !initialBinding) throw new Error("Bound OMP test lane has no terminal pane.")
  const exactSessionId = "omp-session:browser-exact"
  bindExactOmpSession(lane.id, paneId, exactSessionId)
  const actions: string[] = []
  await page.route("**/api/terminal-ticket", async (route) => {
    const body: unknown = route.request().postDataJSON()
    const action = body && typeof body === "object" && "action" in body && typeof body.action === "string" ? body.action : ""
    actions.push(action)
    const resumed = action === "resume-bound"
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticket: resumed ? "resume-ticket" : "attach-ticket",
        mode: resumed ? "resume-exact" : "attach",
        binding: {
          ...initialBinding,
          resumeSessionId: exactSessionId,
          generation: initialBinding.generation + (resumed ? 1 : 0),
        },
      }),
    })
  })
  await page.addInitScript(({ paneId: terminalPaneId, generation, sessionId }) => {
    class ExactResumeSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readyState = ExactResumeSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      readonly resumed: boolean

      constructor(url: string | URL) {
        this.resumed = String(url).includes("resume-ticket")
        setTimeout(() => {
          this.readyState = ExactResumeSocket.OPEN
          this.onopen?.(new Event("open"))
          if (!this.resumed) {
            this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ kind: "missing", generation }) }))
            this.readyState = ExactResumeSocket.CLOSED
            this.onclose?.(new CloseEvent("close", { code: 4404 }))
            return
          }
          const resumedGeneration = generation + 1
          this.onmessage?.(new MessageEvent("message", {
            data: JSON.stringify({
              kind: "binding",
              generation: resumedGeneration,
              binding: {
                paneId: terminalPaneId,
                harnessId: "omp",
                resumeSessionId: sessionId,
                kickoffSent: true,
                generation: resumedGeneration,
                updatedAt: "2026-01-01T00:00:01.000Z",
              },
            }),
          }))
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ kind: "started", generation: resumedGeneration }) }))
        }, 0)
      }

      send() {}
      close() {
        this.readyState = ExactResumeSocket.CLOSED
        this.onclose?.(new CloseEvent("close", { code: 1000 }))
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: ExactResumeSocket })
  }, { paneId, generation: initialBinding.generation, sessionId: exactSessionId })

  try {
    await page.goto(`/lanes/${lane.id}`)
    const terminalPane = page.locator(`[data-pane-id="${paneId}"]`)
    await expect.poll(() => actions.at(-1)).toBe("resume-bound")
    expect(actions.slice(0, -1).every((action) => action === "attach")).toBe(true)
    await expect(terminalPane.locator('[data-terminal-state="open"]')).toBeVisible()
    await expect(terminalPane.getByRole("button", { name: /Choose .*OMP session/i })).toHaveCount(0)
    await expect(terminalPane.getByRole("button", { name: /Resume/i })).toHaveCount(0)
    await expect(terminalPane.getByRole("button", { name: /recipe guidance/i })).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: a delayed layout response cannot erase a same-generation exact identity", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "Bound OMP continuity belongs to Theme Seven.")
  const lane = await createOmpTerminalLane(page, "delayed-layout-binding")
  const initialResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
  const initial: unknown = await initialResponse.json()
  const initialRevision = browserLayoutRevision(initial)
  const [paneId, initialBinding] = Object.entries(browserTerminalBindings(initial))[0] ?? []
  if (!paneId || !initialBinding) throw new Error("Delayed response test lane has no terminal pane.")
  const exactSessionId = "omp-session:delayed-layout"
  const actions: string[] = []
  await page.route("**/api/terminal-ticket", async (route) => {
    const body: unknown = route.request().postDataJSON()
    const action = body && typeof body === "object" && "action" in body && typeof body.action === "string" ? body.action : ""
    actions.push(action)
    const resumed = action === "resume-bound"
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticket: resumed ? "resume-ticket" : "attach-ticket",
        mode: resumed ? "resume-exact" : "attach",
        guidanceIncluded: false,
        binding: {
          ...initialBinding,
          resumeSessionId: resumed ? exactSessionId : null,
          generation: initialBinding.generation + (resumed ? 1 : 0),
          updatedAt: resumed ? "2026-01-01T00:00:02.000Z" : initialBinding.updatedAt,
        },
      }),
    })
  })
  const patchObserved = Promise.withResolvers<void>()
  const patchRelease = Promise.withResolvers<void>()
  await page.route(`**/api/lanes/${lane.id}/layout`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue()
      return
    }
    const submitted = route.request().postDataJSON() as { layout?: unknown }
    patchObserved.resolve()
    await patchRelease.promise
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        layout: submitted.layout,
        layoutRevision: initialRevision + 1,
        terminalBindings: { [paneId]: initialBinding },
      }),
    })
  })
  await page.addInitScript(({ terminalPaneId, generation, sessionId }) => {
    type FakeSocket = {
      readyState: number
      onopen: ((event: Event) => void) | null
      onmessage: ((event: MessageEvent) => void) | null
      onclose: ((event: CloseEvent) => void) | null
      onerror: ((event: Event) => void) | null
      resumed: boolean
    }
    const sockets: FakeSocket[] = []
    const controls = window as unknown as {
      __exactBindingFrameSent: boolean
      __emitAttachMissing: () => void
      __hasOpenAttachSocket: () => boolean
      __emitOldGenerationError: () => void
    }
    controls.__exactBindingFrameSent = false
    class DelayedIdentitySocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readyState = DelayedIdentitySocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      readonly resumed: boolean

      constructor(url: string | URL) {
        this.resumed = String(url).includes("resume-ticket")
        sockets.push(this)
        setTimeout(() => {
          this.readyState = DelayedIdentitySocket.OPEN
          this.onopen?.(new Event("open"))
          const socketGeneration = this.resumed ? generation + 1 : generation
          if (!this.resumed) {
            this.onmessage?.(new MessageEvent("message", {
              data: JSON.stringify({
                kind: "binding",
                generation,
                binding: {
                  paneId: terminalPaneId,
                  harnessId: "omp",
                  resumeSessionId: sessionId,
                  kickoffSent: true,
                  generation,
                  updatedAt: "2026-01-01T00:00:01.000Z",
                },
              }),
            }))
            controls.__exactBindingFrameSent = true
          }
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ kind: "started", generation: socketGeneration }) }))
        }, 0)
      }

      send() {}
      close() {
        this.readyState = DelayedIdentitySocket.CLOSED
        this.onclose?.(new CloseEvent("close", { code: 1000 }))
      }
    }
    controls.__hasOpenAttachSocket = () => sockets.some((socket) => !socket.resumed && socket.readyState === DelayedIdentitySocket.OPEN)
    controls.__emitAttachMissing = () => {
      const current = [...sockets].reverse().find((socket) => !socket.resumed && socket.readyState === DelayedIdentitySocket.OPEN)
      current?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ kind: "missing", generation }) }))
    }
    controls.__emitOldGenerationError = () => {
      const stale = [...sockets].reverse().find((socket) => !socket.resumed)
      stale?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ kind: "error", generation, message: "stale generation error" }) }))
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: DelayedIdentitySocket })
  }, { terminalPaneId: paneId, generation: initialBinding.generation, sessionId: exactSessionId })

  try {
    await page.goto(`/lanes/${lane.id}`)
    const terminalPane = page.locator(`[data-pane-id="${paneId}"]`)
    await expect(terminalPane.locator('[data-terminal-state="open"]')).toBeVisible()
    await page.waitForFunction(() => (window as unknown as { __exactBindingFrameSent?: boolean }).__exactBindingFrameSent === true)
    const openSidebar = page.getByLabel("Open application sidebar")
    if (await openSidebar.isVisible()) await openSidebar.click()
    await page.getByTitle("Click or drag to add Browser").click()
    await patchObserved.promise
    patchRelease.resolve()
    await page.waitForFunction(() => (window as unknown as { __hasOpenAttachSocket: () => boolean }).__hasOpenAttachSocket())
    await expect(page.locator(`[data-layout-revision="${initialRevision + 1}"]`)).toHaveCount(1)

    await page.evaluate(() => (window as unknown as { __emitAttachMissing: () => void }).__emitAttachMissing())
    await expect.poll(() => actions.at(-1)).toBe("resume-bound")
    await expect(terminalPane.locator('[data-terminal-state="open"]')).toBeVisible()
    await page.evaluate(() => (window as unknown as { __emitOldGenerationError: () => void }).__emitOldGenerationError())
    await expect(terminalPane.locator('[data-terminal-state="open"]')).toBeVisible()
    await expect(terminalPane.getByRole("button", { name: /Choose .*OMP session/i })).toHaveCount(0)
    await expect(terminalPane.getByRole("button", { name: /Resume/i })).toHaveCount(0)
  } finally {
    patchRelease.resolve()
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: only an unbound OMP pane offers the explicit native picker", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "Unbound OMP picker scope belongs to Theme Seven.")
  const lane = await createOmpTerminalLane(page, "unbound-omp-picker")
  const initialResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
  const initial: unknown = await initialResponse.json()
  const [paneId, binding] = Object.entries(browserTerminalBindings(initial))[0] ?? []
  if (!paneId || !binding) throw new Error("Unbound OMP test lane has no terminal pane.")
  await page.route("**/api/terminal-ticket", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ticket: "unbound-attach-ticket", mode: "attach", binding }),
    })
  })
  await page.addInitScript(({ generation }) => {
    class MissingUnboundSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readyState = MissingUnboundSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      constructor() {
        setTimeout(() => {
          this.readyState = MissingUnboundSocket.OPEN
          this.onopen?.(new Event("open"))
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ kind: "missing", generation }) }))
          this.readyState = MissingUnboundSocket.CLOSED
          this.onclose?.(new CloseEvent("close", { code: 4404 }))
        }, 0)
      }
      send() {}
      close() {}
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: MissingUnboundSocket })
  }, { generation: binding.generation })

  try {
    await page.goto(`/lanes/${lane.id}`)
    const terminalPane = page.locator(`[data-pane-id="${paneId}"]`)
    await expect(terminalPane.getByRole("button", { name: "Choose local OMP session" })).toBeVisible()
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: serializes layout PATCHes and sends the latest queued snapshot", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "serialized-layout-save", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const observed = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const patches: Array<{ layout?: unknown; baseRevision?: number }> = []
  await page.route(`**/api/lanes/${lane.id}/layout`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue()
      return
    }
    patches.push(route.request().postDataJSON() as { layout?: unknown; baseRevision?: number })
    if (patches.length === 1) {
      observed.resolve()
      await release.promise
    }
    await route.continue()
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    const openSidebar = page.getByLabel("Open application sidebar")
    if (await openSidebar.isVisible()) await openSidebar.click()
    await page.getByTitle("Click or drag to add Browser").click()
    await observed.promise
    const browserPane = page.locator('[data-pane-id^="web-preview-"]')
    await expect(browserPane).toBeVisible()
    await browserPane.getByRole("button", { name: "Close pane" }).click()
    await page.waitForTimeout(500)
    expect(patches).toHaveLength(1)

    release.resolve()
    await expect.poll(() => patches.length).toBe(2)
    expect(patches[1].baseRevision).toBe((patches[0].baseRevision ?? 0) + 1)
    const latest = JSON.stringify(patches[1].layout)
    expect(latest).not.toContain("web-preview")
    expect((latest.match(/\"pane\":\"terminal\"/g) ?? [])).toHaveLength(1)
  } finally {
    release.resolve()
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: Retry save submits the latest snapshot after a layout 5xx", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "retry-latest-layout", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const patches: Array<{ layout?: unknown; baseRevision?: number }> = []
  await page.route(`**/api/lanes/${lane.id}/layout`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue()
      return
    }
    patches.push(route.request().postDataJSON() as { layout?: unknown; baseRevision?: number })
    if (patches.length === 1) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "isolated failure" }) })
      return
    }
    await route.continue()
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    const openSidebar = page.getByLabel("Open application sidebar")
    if (await openSidebar.isVisible()) await openSidebar.click()
    await page.getByTitle("Click or drag to add Browser").click()
    const retry = page.getByRole("button", { name: "Retry save" })
    await expect(retry).toBeVisible()
    const browserPane = page.locator('[data-pane-id^="web-preview-"]')
    await expect(browserPane).toBeVisible()
    await browserPane.getByRole("button", { name: "Close pane" }).click()
    expect(patches).toHaveLength(1)
    await retry.click({ force: true })
    await expect.poll(() => patches.length).toBe(2)
    const retried = JSON.stringify(patches[1].layout)
    expect(retried).not.toContain("web-preview")
    expect((retried.match(/\"pane\":\"terminal\"/g) ?? [])).toHaveLength(1)
    await expect(retry).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: a stale second page adopts 409 canonical layout without resurrecting a pane", async ({ page, context }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "two-page-layout-conflict", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const second = await context.newPage()
  await second.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined })
  })
  try {
    await page.goto(`/lanes/${lane.id}`)
    await second.goto(`/lanes/${lane.id}`)
    const firstSidebar = page.getByLabel("Open application sidebar")
    if (await firstSidebar.isVisible()) await firstSidebar.click()
    const secondSidebar = second.getByLabel("Open application sidebar")
    if (await secondSidebar.isVisible()) await secondSidebar.click()
    const before = await page.request.get(`/api/lanes/${lane.id}/layout`)
    const beforeState: unknown = await before.json()
    const beforeRevision = browserLayoutRevision(beforeState)
    await page.getByTitle("Click or drag to add Browser").click()
    await expect.poll(async () => {
      const response = await page.request.get(`/api/lanes/${lane.id}/layout`)
      const state: unknown = await response.json()
      return browserLayoutRevision(state)
    }).toBe(beforeRevision + 1)

    await second.getByTitle("Click or drag to add Agent terminal").click()
    await expect(second.getByText("Layout changed in another window. The current layout was reloaded.")).toBeVisible()
    await expect(second.locator('[data-pane-id^="web-preview-"]')).toBeVisible()
    await expect(second.locator('[data-pane-id^="terminal-"]')).toHaveCount(1)
    const canonical = await second.request.get(`/api/lanes/${lane.id}/layout`)
    const canonicalBody = JSON.stringify(await canonical.json())
    expect((canonicalBody.match(/\"paneId\":\"terminal-/g) ?? [])).toHaveLength(1)
  } finally {
    await second.close()
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: web-preview intent ACK waits for its serialized layout save", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "preview-intent-save-barrier", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const stateResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
  const state: unknown = await stateResponse.json()
  const binding = browserTerminalBindings(state)["terminal-main"]
  const capability = signTerminalControlCapability({
    laneId: lane.id,
    paneId: "terminal-main",
    generation: binding.generation,
  }, {
    NODE_ENV: "production",
    OPERATOR_ENGINE_TERMINAL_SECRET: "fixture-browser-smoke-secret",
  })
  const patchObserved = Promise.withResolvers<void>()
  const patchRelease = Promise.withResolvers<void>()
  let acknowledgements = 0
  await page.route(`**/api/lanes/${lane.id}/layout`, async (route) => {
    if (route.request().method() !== "PATCH" || !JSON.stringify(route.request().postDataJSON()).includes("web-preview-")) {
      await route.continue()
      return
    }
    patchObserved.resolve()
    await patchRelease.promise
    await route.continue()
  })
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes(`/api/lanes/${lane.id}/control-intents`)) acknowledgements += 1
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    const queued = await page.request.post("/api/control/web-preview/open", {
      headers: { "x-operator-engine-control-token": capability },
      data: { location: "http://127.0.0.1:3000/" },
    })
    expect(queued.ok(), JSON.stringify(await queued.json())).toBe(true)
    await patchObserved.promise
    expect(acknowledgements).toBe(0)

    patchRelease.resolve()
    await expect.poll(() => acknowledgements).toBe(1)
    await expect(page.locator('[data-pane-id^="web-preview-"]')).toBeVisible()
  } finally {
    patchRelease.resolve()
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

for (const canonicalOutcome of ["absent", "present"] as const) {
  test(`terminal continuity: response-unknown close keeps canonical ${canonicalOutcome} state`, async ({ page }) => {
    test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
    const lane = await createLaneWithLayout(page, `unknown-close-${canonicalOutcome}`, {
      kind: "tabs",
      activeId: "terminal-main",
      panes: [
        { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
        { kind: "pane", id: "files-main", pane: "files" },
      ],
    })
    await page.route(`**/api/lanes/${lane.id}/panes/terminal-main`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue()
        return
      }
      if (canonicalOutcome === "absent") {
        const committed = await page.request.delete(route.request().url(), {
          data: route.request().postDataJSON(),
        })
        const committedPayload = await committed.json()
        expect(committed.ok(), JSON.stringify(committedPayload)).toBe(true)
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "The close response was lost." }),
      })
    })

    try {
      await page.goto(`/lanes/${lane.id}`)
      const terminalPane = page.locator('[data-pane-id="terminal-main"]')
      await terminalPane.getByRole("button", { name: "Close pane" }).click()
      await page.getByRole("button", { name: "Close terminal" }).click()

      if (canonicalOutcome === "absent") {
        await expect(terminalPane).toHaveCount(0)
        await expect(page.getByRole("alertdialog", { name: "Close agent terminal?" })).toHaveCount(0)
      } else {
        await expect(terminalPane).toBeVisible()
        await expect(page.getByRole("alertdialog", { name: "Close agent terminal?" })).toBeVisible()
        await expect(page.getByText("Terminal close could not be confirmed. Retry after the current layout is available.")).toBeVisible()
      }
    } finally {
      await page.request.delete(`/api/lanes/${lane.id}`)
      await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
}

test("terminal continuity: a stale generation close intent is ACKed without closing its replacement", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "stale-close-intent", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const initialResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
  const initial: unknown = await initialResponse.json()
  const initialBinding = browserTerminalBindings(initial)["terminal-main"]
  const capability = signTerminalControlCapability({
    laneId: lane.id,
    paneId: "terminal-main",
    generation: initialBinding.generation,
  }, {
    NODE_ENV: "production",
    OPERATOR_ENGINE_TERMINAL_SECRET: "fixture-browser-smoke-secret",
  })

  try {
    const queued = await page.request.post("/api/control/terminal/close", {
      headers: { "x-operator-engine-control-token": capability },
    })
    const queuedPayload = await queued.json()
    expect(queued.status(), JSON.stringify(queuedPayload)).toBe(202)

    const replacement = await page.request.post("/api/terminal-ticket", {
      data: {
        laneId: lane.id,
        paneId: "terminal-main",
        action: "new-session",
        harnessId: "shell",
        expectedGeneration: initialBinding.generation,
      },
    })
    const replacementPayload: unknown = await replacement.json()
    expect(replacement.ok(), JSON.stringify(replacementPayload)).toBe(true)
    const replacementBinding = browserTerminalBindings({ terminalBindings: {
      "terminal-main": replacementPayload && typeof replacementPayload === "object" && "binding" in replacementPayload
        ? replacementPayload.binding
        : null,
    } })["terminal-main"]
    expect(replacementBinding.generation).toBe(initialBinding.generation + 1)

    await page.goto(`/lanes/${lane.id}`)
    await expect(page.getByText("This terminal changed before the close command could be applied.")).toBeVisible()
    await expect(page.locator('[data-pane-id="terminal-main"]')).toBeVisible()
    await expect.poll(async () => {
      const response = await page.request.get(`/api/lanes/${lane.id}/control-intents`)
      const payload = await response.json() as { intents?: unknown[] }
      return payload.intents?.length ?? -1
    }).toBe(0)
    const canonical = await page.request.get(`/api/lanes/${lane.id}/layout`)
    expect(browserTerminalBindings(await canonical.json())["terminal-main"].generation).toBe(replacementBinding.generation)
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: browser caches never override canonical layout or bindings", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "canonical-over-browser-cache", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const cases = ["missing", "corrupt", "stale-v2"] as const

  try {
    for (const cacheCase of cases) {
      if (page.url() === "about:blank") {
        await page.goto(`/lanes/${lane.id}`)
      }
      await page.evaluate(({ laneId, cacheCase: selected }) => {
        const v2 = `operator-engine:bento:v2:${laneId}`
        localStorage.removeItem(v2)
        const stale = {
          schemaVersion: 1,
          tree: {
            kind: "pane",
            id: "web-preview-cache",
            pane: "web-preview",
            config: { location: "http://cache.invalid/", revision: 0, sourcePaneId: "terminal-cache" },
          },
        }
        if (selected === "corrupt") localStorage.setItem(v2, "{not-json")
        if (selected === "stale-v2") localStorage.setItem(v2, JSON.stringify({ layoutRevision: 0, layout: stale }))
      }, { laneId: lane.id, cacheCase })
      await page.goto(`/lanes/${lane.id}`)
      await expect(page.locator('[data-pane-id="terminal-main"]')).toBeAttached()
      await expect(page.locator('[data-pane-id="files-main"]')).toBeAttached()
      await expect(page.locator('[data-pane-id="web-preview-cache"]')).toHaveCount(0)
      await expect(page.locator('[data-pane-id="terminal-cache"]')).toHaveCount(0)
    }

    const canonical = await page.request.get(`/api/lanes/${lane.id}/layout`)
    const canonicalPayload: unknown = await canonical.json()
    expect(Object.keys(browserTerminalBindings(canonicalPayload))).toEqual(["terminal-main"])
    expect(JSON.stringify(canonicalPayload)).not.toContain("web-preview-cache")
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: closes the middle live pane and serializes confirmation-disabled close", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  test.setTimeout(90_000)
  const lane = await createLaneWithLayout(page, "middle-live-pane-close", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "terminal-middle", pane: "terminal", config: { role: "additional" } },
      { kind: "pane", id: "terminal-last", pane: "terminal", config: { role: "additional" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const requests: Array<{ kind: "patch" | "delete"; paneId?: string }> = []
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith(`/api/lanes/${lane.id}/layout`)) {
      requests.push({ kind: "patch" })
      return
    }
    if (request.method() !== "DELETE" || !request.url().includes(`/api/lanes/${lane.id}/panes/`)) return
    requests.push({ kind: "delete", paneId: decodeURIComponent(request.url().split("/panes/")[1] ?? "") })
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    const terminalIds = ["terminal-main", "terminal-middle", "terminal-last"]
    for (const [index, paneId] of terminalIds.entries()) {
      await page.getByRole("tab").nth(index).click()
      const pane = page.locator(`[data-pane-id="${paneId}"]`)
      await pane.getByRole("button", { name: "Open Shell in this folder" }).click()
      await expect(pane.locator('[data-terminal-state="open"]')).toBeAttached({ timeout: 10_000 })
    }

    await page.getByRole("tab").nth(1).click()
    const middle = page.locator('[data-pane-id="terminal-middle"]')
    await middle.getByRole("button", { name: "Close pane" }).click()
    const closeDialog = page.getByRole("alertdialog", { name: "Close agent terminal?" })
    await closeDialog.getByLabel("Don't ask again in this lane").check()
    await closeDialog.getByRole("button", { name: "Close terminal" }).click()
    await expect(middle).toHaveCount(0)
    await expect(closeDialog).toHaveCount(0)
    await expect(page.locator('[data-pane-id="terminal-main"] [data-terminal-state="open"]')).toBeAttached()
    await expect(page.locator('[data-pane-id="terminal-last"] [data-terminal-state="open"]')).toBeAttached()

    for (const [index, paneId] of ["terminal-main", "terminal-last"].entries()) {
      await page.getByRole("tab").nth(index).click()
      const pane = page.locator(`[data-pane-id="${paneId}"]`)
      await expect(pane).toBeVisible()
      const marker = `survivor-${paneId}-${Date.now()}`
      const input = pane.locator(".xterm-helper-textarea")
      await input.focus()
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press("Enter")
      await expect(pane.locator(".xterm-rows")).toContainText(marker, { timeout: 10_000 })
    }

    const sequenceStart = requests.length
    await page.getByRole("tab").nth(0).click()
    await page.getByRole("tab").nth(1).click()
    const last = page.locator('[data-pane-id="terminal-last"]')
    await last.getByRole("button", { name: "Close pane" }).click()
    await expect(page.getByRole("alertdialog", { name: "Close agent terminal?" })).toHaveCount(0)
    await expect(last).toHaveCount(0)
    await page.waitForTimeout(500)

    const closeSequence = requests.slice(sequenceStart)
    const patchIndex = closeSequence.findIndex((entry) => entry.kind === "patch")
    const deleteIndex = closeSequence.findIndex((entry) => entry.kind === "delete" && entry.paneId === "terminal-last")
    expect(patchIndex).toBeGreaterThanOrEqual(0)
    expect(deleteIndex).toBeGreaterThan(patchIndex)
    expect(closeSequence.slice(deleteIndex + 1).some((entry) => entry.kind === "patch")).toBe(false)
    await expect(page.locator('[data-pane-id="terminal-main"] [data-terminal-state="open"]')).toBeAttached()
    await expect(page.locator('[data-pane-id="files-main"]')).toBeAttached()
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test("terminal continuity: explicit close sends pane generation, keeps its sibling, and surfaces cleanup failure", async ({ page }) => {
  test.skip(browserDistribution !== "theme-7", "The continuity browser gate runs under Theme Seven.")
  const lane = await createLaneWithLayout(page, "exact-pane-close", {
    kind: "tabs",
    activeId: "terminal-main",
    panes: [
      { kind: "pane", id: "terminal-main", pane: "terminal", config: { role: "first" } },
      { kind: "pane", id: "files-main", pane: "files" },
    ],
  })
  const initialResponse = await page.request.get(`/api/lanes/${lane.id}/layout`)
  const initial: unknown = await initialResponse.json()
  if (!initial || typeof initial !== "object"
    || !("layoutRevision" in initial) || typeof initial.layoutRevision !== "number"
    || !("terminalBindings" in initial) || !initial.terminalBindings || typeof initial.terminalBindings !== "object"
    || !("terminal-main" in initial.terminalBindings) || !initial.terminalBindings["terminal-main"]
    || typeof initial.terminalBindings["terminal-main"] !== "object"
    || !("generation" in initial.terminalBindings["terminal-main"])
    || typeof initial.terminalBindings["terminal-main"].generation !== "number") {
    throw new Error("Exact close test lane returned an invalid binding state.")
  }
  const initialRevision = initial.layoutRevision
  const initialGeneration = initial.terminalBindings["terminal-main"].generation
  let closeBody: unknown = null
  await page.route(`**/api/lanes/${lane.id}/panes/terminal-main`, async (route) => {
    closeBody = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        layout: { schemaVersion: 1, tree: { kind: "pane", id: "files-main", pane: "files" } },
        layoutRevision: initialRevision + 1,
        terminalBindings: {},
        terminated: false,
        cleanupError: "Isolated relay cleanup timed out.",
      }),
    })
  })

  try {
    await page.goto(`/lanes/${lane.id}`)
    await page.locator('[data-pane-id="terminal-main"]').getByRole("button", { name: "Close pane" }).click()
    await page.getByRole("button", { name: "Close terminal" }).click()
    await expect(page.getByText("Isolated relay cleanup timed out.")).toBeVisible()
    expect(closeBody).toEqual({ baseRevision: initialRevision, expectedGeneration: initialGeneration })
    await expect(page.locator('[data-pane-id="terminal-main"]')).toHaveCount(0)
    await expect(page.locator('[data-pane-id="files-main"]')).toBeVisible()
  } finally {
    await page.request.delete(`/api/lanes/${lane.id}`)
    await fs.rm(lane.path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
