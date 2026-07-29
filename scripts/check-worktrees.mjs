#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { evaluateWorktreePolicy, parseWorktreePorcelain } from "./worktree-policy-core.mjs"

function git(args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
  if (!allowFailure && result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim())
  return result
}

const repositoryRoot = git(["rev-parse", "--show-toplevel"], process.cwd()).stdout.trim()
const policyPath = path.join(repositoryRoot, "worktree-policy.json")
if (!fs.existsSync(policyPath)) throw new Error("worktree-policy.json is required.")
const config = JSON.parse(fs.readFileSync(policyPath, "utf8"))
const worktrees = parseWorktreePorcelain(git(["worktree", "list", "--porcelain"], repositoryRoot).stdout)
const canonicalResult = git(["rev-parse", "--verify", config.canonicalBranch], repositoryRoot, { allowFailure: true })
if (canonicalResult.status !== 0) {
  process.stderr.write(`Worktree policy failed:\n- Canonical branch ${config.canonicalBranch} does not exist locally.\n`)
  process.exit(1)
}
const canonicalCommit = canonicalResult.stdout.trim()
const dirtyPaths = new Set()
const mergedBranches = new Set()
for (const worktree of worktrees) {
  const status = git(["-C", worktree.path, "status", "--porcelain", "--untracked-files=normal"], repositoryRoot)
  if (status.stdout.trim()) dirtyPaths.add(process.platform === "win32" ? path.resolve(worktree.path).toLowerCase() : path.resolve(worktree.path))
  if (worktree.branch && config.temporaryWorktrees?.some((entry) => entry.branch === worktree.branch)) {
    const merged = git(["merge-base", "--is-ancestor", worktree.branch, config.canonicalBranch], repositoryRoot, { allowFailure: true })
    if (merged.status === 0) mergedBranches.add(worktree.branch)
    else if (merged.status !== 1) throw new Error((merged.stderr || `Could not compare ${worktree.branch} with ${config.canonicalBranch}.`).trim())
  }
}
const today = new Date().toISOString().slice(0, 10)
const errors = evaluateWorktreePolicy({ config, worktrees, currentPath: repositoryRoot, canonicalCommit, dirtyPaths, mergedBranches, today })
if (errors.length) {
  process.stderr.write(`Worktree policy failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`)
  process.exit(1)
}
process.stdout.write(`Worktree policy passed: ${config.canonicalBranch}; ${worktrees.length} registered worktree${worktrees.length === 1 ? "" : "s"}; ${config.temporaryWorktrees.length} temporary.\n`)
