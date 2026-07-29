import path from "node:path"
import { describe, expect, it } from "vitest"

import { evaluateWorktreePolicy, parseWorktreePorcelain, validateWorktreePolicyConfig } from "./worktree-policy-core.mjs"

const canonicalCommit = "a".repeat(40)
const canonicalPath = path.resolve("repo-canonical")
const anchorPath = path.resolve("repo-anchor")
const featurePath = path.resolve("repo-feature")
const normalized = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
const config = (temporaryWorktrees = []) => ({
  schemaVersion: 1,
  canonicalBranch: "main",
  repositoryAnchorBranches: ["repository-anchor"],
  temporaryWorktrees,
})
const worktree = (directory, branch, head = canonicalCommit) => ({ path: directory, head, branch, detached: !branch, prunable: false })
const evaluate = ({ policy = config(), worktrees = [worktree(canonicalPath, "main")], currentPath = canonicalPath, dirtyPaths = new Set(), mergedBranches = new Set(), today = "2026-07-16" } = {}) => evaluateWorktreePolicy({
  config: policy,
  worktrees,
  currentPath,
  canonicalCommit,
  dirtyPaths,
  mergedBranches,
  today,
})

describe("worktree policy", () => {
  it("parses branch and detached porcelain records", () => {
    expect(parseWorktreePorcelain(`worktree C:/repo one\nHEAD ${canonicalCommit}\nbranch refs/heads/main\n\nworktree C:/build\nHEAD ${canonicalCommit}\ndetached\n`)).toEqual([
      { path: "C:/repo one", head: canonicalCommit, branch: "main", detached: false, prunable: false },
      { path: "C:/build", head: canonicalCommit, branch: null, detached: true, prunable: false },
    ])
  })

  it("accepts one canonical worktree and its clean repository anchor", () => {
    expect(evaluate({ worktrees: [worktree(canonicalPath, "main"), worktree(anchorPath, "repository-anchor")] })).toEqual([])
  })

  it("accepts a detached validation worktree at the canonical commit", () => {
    const detachedPath = path.resolve("candidate-build")
    expect(evaluate({ worktrees: [worktree(anchorPath, "repository-anchor"), worktree(detachedPath, null)], currentPath: detachedPath })).toEqual([])
  })

  it("rejects an undeclared feature worktree", () => {
    expect(evaluate({ worktrees: [worktree(canonicalPath, "main"), worktree(featurePath, "feature/panes")] })).toContain("feature/panes is not the canonical, repository anchor, or a declared temporary worktree.")
  })

  it("rejects dirty work in any registered worktree", () => {
    const errors = evaluate({ worktrees: [worktree(canonicalPath, "main"), worktree(anchorPath, "repository-anchor")], dirtyPaths: new Set([normalized(anchorPath)]) })
    expect(errors.some((error) => error.includes("repository-anchor is dirty"))).toBe(true)
  })

  it("requires temporary worktrees to name an owner, outcome, and removal date", () => {
    expect(validateWorktreePolicyConfig(config([{ branch: "feature/panes" }]))).toEqual(expect.arrayContaining([
      "Temporary worktree feature/panes must name its owner.",
      "Temporary worktree feature/panes must name one bounded outcome.",
      "Temporary worktree feature/panes must use an absolute removeAfter date.",
    ]))
  })

  it("rejects expired and already-merged temporary worktrees", () => {
    const policy = config([{ branch: "feature/panes", owner: "agent", outcome: "Add pane counts", removeAfter: "2026-07-15" }])
    const errors = evaluate({ policy, worktrees: [worktree(canonicalPath, "main"), worktree(featurePath, "feature/panes")], mergedBranches: new Set(["feature/panes"]) })
    expect(errors).toEqual(expect.arrayContaining([
      "feature/panes expired on 2026-07-15; reconcile and remove it.",
      "feature/panes is already merged into main; remove its worktree and declaration.",
    ]))
  })

  it("rejects stale temporary declarations without worktrees", () => {
    const policy = config([{ branch: "feature/panes", owner: "agent", outcome: "Add pane counts", removeAfter: "2026-07-17" }])
    expect(evaluate({ policy })).toContain("feature/panes is declared temporary but has no worktree; remove the stale declaration.")
  })
})
