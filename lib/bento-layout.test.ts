import { describe, expect, it } from "vitest"

import { defaultLayout, findFirstPaneByType, insertPane, movePane, openWebPreview, paneIds, parseSavedLayout, removePane, terminalPane, terminalPaneConfig, updatePane, webPreviewPaneConfig } from "@/lib/bento-layout"
import { updatePaneInTree } from "../scripts/layout-tree-policy.mjs"

describe("Operator Engine Bento layout", () => {
  it("subdivides the current lane with another terminal agent", () => {
    const next = insertPane(
      defaultLayout(),
      "terminal-main",
      { kind: "pane", id: "terminal-two", pane: "terminal" },
      "right"
    )
    expect(paneIds(next)).toEqual(["terminal-main", "terminal-two", "files-main"])
  })

  it("moves a pane into a tab group without losing it", () => {
    const next = movePane(defaultLayout(), "files-main", "terminal-main", "center")
    expect(paneIds(next).sort()).toEqual(["files-main", "terminal-main"])
    expect(next.kind).toBe("tabs")
  })

  it("collapses a split when a pane closes", () => {
    expect(removePane(defaultLayout(), "files-main")).toEqual({
      kind: "pane",
      id: "terminal-main",
      pane: "terminal",
      config: { role: "first" },
    })
  })

  it("restores a closed files pane from the pane palette", () => {
    const withoutFiles = removePane(defaultLayout(), "files-main")
    expect(withoutFiles).not.toBeNull()
    const restored = insertPane(
      withoutFiles!,
      "terminal-main",
      { kind: "pane", id: "files-restored", pane: "files" },
      "right"
    )
    expect(paneIds(restored)).toEqual(["terminal-main", "files-restored"])
  })

  it("strips legacy terminal runtime identity while preserving its visual role", () => {
    const old = { kind: "pane", id: "old-terminal", pane: "terminal" }
    expect(parseSavedLayout(old)).toEqual({
      schemaVersion: 1,
      tree: { ...old, config: { role: "additional" } },
    })
  })

  it("keeps terminal runtime launch state out of visual layouts", () => {
    expect(terminalPane("new-terminal", "additional").config).toEqual({ role: "additional" })
    const saved = parseSavedLayout({ schemaVersion: 1, tree: { kind: "pane", id: "saved-terminal", pane: "terminal", config: { harnessId: "omp", role: "additional", kickoffSent: false, launchOnMount: true } } })
    expect(saved?.tree).toEqual({ kind: "pane", id: "saved-terminal", pane: "terminal", config: { role: "additional" } })
  })

  it.each(["yes", null, 1, { enabled: true }])("omits invalid launchOnMount values from terminal pane configuration", (launchOnMount) => {
    expect(terminalPaneConfig({
      kind: "pane",
      id: "terminal",
      pane: "terminal",
      config: { harnessId: "omp", role: "additional", kickoffSent: false, launchOnMount },
    })).toEqual({ role: "additional" })
  })

  it("keeps T4 opt-in rather than adding it to the stock terminal and Files layout", () => {
    expect(paneIds(defaultLayout())).toEqual(["terminal-main", "files-main"])
    expect(paneIds(defaultLayout(["terminal", "t4-code", "files"]))).toEqual(["terminal-main", "t4-code-main", "files-main"])
  })

  it("falls back to the stock terminal and Files layout when every persisted pane is unsupported", () => {
    const saved = parseSavedLayout({
      schemaVersion: 1,
      tree: {
        kind: "split",
        direction: "horizontal",
        percentage: 35,
        first: { kind: "pane", id: "activity", pane: "threads" },
        second: {
          kind: "tabs",
          activeId: "history",
          panes: [
            { kind: "pane", id: "history", pane: "local-threads" },
            { kind: "pane", id: "future", pane: "future-pane" },
          ],
        },
      },
    })
    expect(saved).toEqual({ schemaVersion: 1, tree: defaultLayout() })
  })

  it("recursively prunes legacy panes and preserves the surviving split semantics", () => {
    const saved = parseSavedLayout({
      schemaVersion: 1,
      tree: {
        kind: "split",
        direction: "horizontal",
        percentage: 61,
        first: {
          kind: "tabs",
          activeId: "activity",
          panes: [
            { kind: "pane", id: "activity", pane: "threads" },
            { kind: "pane", id: "graphical", pane: "t4-code", config: { retained: true } },
            { kind: "pane", id: "agent", pane: "terminal" },
          ],
        },
        second: {
          kind: "split",
          direction: "vertical",
          percentage: 25,
          first: { kind: "pane", id: "unknown", pane: "custom-pane" },
          second: {
            kind: "tabs",
            activeId: "history",
            panes: [
              { kind: "pane", id: "history", pane: "local-threads" },
              { kind: "pane", id: "files", pane: "files" },
            ],
          },
        },
      },
    })
    expect(saved).toEqual({
      schemaVersion: 1,
      tree: {
        kind: "split",
        direction: "horizontal",
        percentage: 61,
        first: {
          kind: "tabs",
          activeId: "graphical",
          panes: [
            { kind: "pane", id: "graphical", pane: "t4-code", config: { retained: true } },
            {
              kind: "pane",
              id: "agent",
              pane: "terminal",
              config: { role: "additional" },
            },
          ],
        },
        second: { kind: "pane", id: "files", pane: "files" },
      },
    })
  })

  it("supports multiple visual terminal panes without runtime identity", () => {
    const base = defaultLayout(["terminal"])
    const mixed = insertPane(base, "terminal-main", { kind: "pane", id: "terminal-two", pane: "terminal", config: { role: "additional" } }, "right")
    expect(paneIds(mixed)).toEqual(["terminal-main", "terminal-two"])
  })

  it("strips exact terminal identity while migrating and collapsing a legacy visual layout", () => {
    const saved = parseSavedLayout({
      kind: "split",
      direction: "vertical",
      percentage: 20,
      first: { kind: "pane", id: "history", pane: "local-threads" },
      second: {
        kind: "pane",
        id: "resuming-terminal",
        pane: "terminal",
        config: { role: "first", kickoffSent: false, resumeSessionId: "session-123", launchOnMount: true },
      },
    })
    expect(saved).toEqual({
      schemaVersion: 1,
      tree: {
        kind: "pane",
        id: "resuming-terminal",
        pane: "terminal",
        config: { role: "first" },
      },
    })
  })

  it.each(["", { threadId: "legacy-thread" }])("strips malformed terminal identity with every other runtime field", (resumeSessionId) => {
    const saved = parseSavedLayout({
      schemaVersion: 1,
      tree: {
        kind: "pane",
        id: "terminal",
        pane: "terminal",
        config: {
          harnessId: "codex",
          role: "first",
          kickoffSent: false,
          resumeSessionId,
          launchOnMount: true,
        },
      },
    })
    expect(saved).toEqual({
      schemaVersion: 1,
      tree: {
        kind: "pane",
        id: "terminal",
        pane: "terminal",
        config: { role: "first" },
      },
    })
  })

  it("activates a nested tab without replacing the surrounding layout", () => {
    const withAgent = insertPane(defaultLayout(), "terminal-main", { kind: "pane", id: "terminal-two", pane: "terminal" }, "right")
    const withTabs = movePane(withAgent, "files-main", "terminal-two", "center")
    const activated = updatePane(withTabs, "files-main", (pane) => pane)
    expect(paneIds(activated).sort()).toEqual(["files-main", "terminal-main", "terminal-two"])
    expect(findFirstPaneByType(activated, "files")?.id).toBe("files-main")
    expect(JSON.stringify(activated)).toContain('"activeId":"files-main"')
  })

  it("opens a Browser beside its source pane and reuses it", () => {
    const opened = openWebPreview(defaultLayout(), { location: "demo/index.html", sourcePaneId: "terminal-main", newPaneId: "preview-one" })
    expect(paneIds(opened)).toEqual(["terminal-main", "preview-one", "files-main"])
    const refreshed = openWebPreview(opened, { location: "http://127.0.0.1:3000/", sourcePaneId: "terminal-main", newPaneId: "preview-two" })
    expect(paneIds(refreshed)).toEqual(["terminal-main", "preview-one", "files-main"])
    expect(webPreviewPaneConfig(findFirstPaneByType(refreshed, "web-preview")!)).toEqual({ location: "http://127.0.0.1:3000/", revision: 2 })
  })

  it("repairs malformed Browser configuration and migrates an old entryPath", () => {
    const saved = parseSavedLayout({ schemaVersion: 1, tree: { kind: "pane", id: "preview", pane: "web-preview", config: { entryPath: 42, revision: -5 } } })
    expect(saved).toEqual({ schemaVersion: 1, tree: { kind: "pane", id: "preview", pane: "web-preview", config: { location: null, revision: 0 } } })
    const migrated = parseSavedLayout({ schemaVersion: 1, tree: { kind: "pane", id: "preview", pane: "web-preview", config: { entryPath: "demo/index.html", revision: 3 } } })
    expect(migrated).toEqual({ schemaVersion: 1, tree: { kind: "pane", id: "preview", pane: "web-preview", config: { location: "demo/index.html", revision: 3 } } })
  })

  it("keeps the first persisted Browser, migrates its config, and collapses the removed duplicate", () => {
    const saved = parseSavedLayout({
      schemaVersion: 1,
      tree: {
        kind: "split",
        direction: "horizontal",
        percentage: 44,
        first: {
          kind: "tabs",
          activeId: "activity",
          panes: [
            { kind: "pane", id: "activity", pane: "threads" },
            { kind: "pane", id: "preview-one", pane: "web-preview", config: { entryPath: "one/index.html", revision: 3 } },
            { kind: "pane", id: "graphical", pane: "t4-code" },
          ],
        },
        second: {
          kind: "split",
          direction: "vertical",
          percentage: 30,
          first: { kind: "pane", id: "files", pane: "files" },
          second: { kind: "pane", id: "preview-two", pane: "web-preview", config: { location: "two/index.html", revision: 8 } },
        },
      },
    })
    expect(saved).toEqual({
      schemaVersion: 1,
      tree: {
        kind: "split",
        direction: "horizontal",
        percentage: 44,
        first: {
          kind: "tabs",
          activeId: "preview-one",
          panes: [
            { kind: "pane", id: "preview-one", pane: "web-preview", config: { location: "one/index.html", revision: 3 } },
            { kind: "pane", id: "graphical", pane: "t4-code" },
          ],
        },
        second: { kind: "pane", id: "files", pane: "files" },
      },
    })
  })

  it("opens beside a tab group without discarding sibling tabs", () => {
    const tabs = movePane(defaultLayout(), "files-main", "terminal-main", "center")
    const opened = openWebPreview(tabs, { location: "index.html", sourcePaneId: "terminal-main", newPaneId: "preview" })
    expect(paneIds(opened).sort()).toEqual(["files-main", "preview", "terminal-main"])
  })
  it("shares the bare-Node visual pane traversal policy", () => {
    const tree = defaultLayout()
    const updated = updatePaneInTree(tree, "terminal-main", (pane) => ({ ...pane, config: { role: "additional" } }))
    expect(updatePane(updated, "terminal-main", (pane) => pane)).toEqual(updated)
    expect(terminalPaneConfig(findFirstPaneByType(updated, "terminal")!)).toEqual({ role: "additional" })
  })

})
