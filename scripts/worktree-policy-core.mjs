import path from "node:path"

function normalizedPath(value) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function parseWorktreePorcelain(input) {
  return input.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const record = { path: "", head: "", branch: null, detached: false, prunable: false }
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) record.path = line.slice("worktree ".length)
      else if (line.startsWith("HEAD ")) record.head = line.slice("HEAD ".length)
      else if (line.startsWith("branch refs/heads/")) record.branch = line.slice("branch refs/heads/".length)
      else if (line === "detached") record.detached = true
      else if (line.startsWith("prunable")) record.prunable = true
    }
    return record
  })
}

export function validateWorktreePolicyConfig(config) {
  const errors = []
  if (config?.schemaVersion !== 1) errors.push("worktree-policy.json must use schemaVersion 1.")
  if (typeof config?.canonicalBranch !== "string" || !config.canonicalBranch.trim()) errors.push("worktree-policy.json must name canonicalBranch.")
  if (!Array.isArray(config?.repositoryAnchorBranches) || config.repositoryAnchorBranches.some((branch) => typeof branch !== "string" || !branch.trim())) {
    errors.push("repositoryAnchorBranches must be an array of branch names.")
  }
  if (!Array.isArray(config?.temporaryWorktrees)) {
    errors.push("temporaryWorktrees must be an array.")
  } else {
    const branches = new Set()
    for (const entry of config.temporaryWorktrees) {
      if (typeof entry?.branch !== "string" || !entry.branch.trim()) errors.push("Every temporary worktree must name its branch.")
      else if (branches.has(entry.branch)) errors.push(`Temporary worktree ${entry.branch} is declared more than once.`)
      else branches.add(entry.branch)
      if (typeof entry?.owner !== "string" || !entry.owner.trim()) errors.push(`Temporary worktree ${entry?.branch ?? "<unknown>"} must name its owner.`)
      if (typeof entry?.outcome !== "string" || !entry.outcome.trim()) errors.push(`Temporary worktree ${entry?.branch ?? "<unknown>"} must name one bounded outcome.`)
      if (typeof entry?.removeAfter !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.removeAfter)) errors.push(`Temporary worktree ${entry?.branch ?? "<unknown>"} must use an absolute removeAfter date.`)
    }
  }
  return errors
}

export function evaluateWorktreePolicy({ config, worktrees, currentPath, canonicalCommit, dirtyPaths = new Set(), mergedBranches = new Set(), today }) {
  const errors = validateWorktreePolicyConfig(config)
  if (errors.length) return errors

  const current = normalizedPath(currentPath)
  const anchors = new Set(config.repositoryAnchorBranches)
  const temporary = new Map(config.temporaryWorktrees.map((entry) => [entry.branch, entry]))
  const presentBranches = new Set(worktrees.flatMap((worktree) => worktree.branch ? [worktree.branch] : []))
  let canonicalPresent = false
  let canonicalDetachedPresent = false

  for (const worktree of worktrees) {
    const worktreePath = normalizedPath(worktree.path)
    const label = worktree.branch ?? `detached ${worktree.head.slice(0, 12)}`
    if (!worktree.path || !worktree.head) errors.push("Git reported an incomplete worktree record.")
    if (worktree.prunable) errors.push(`${label} has stale worktree metadata; prune it.`)
    if (dirtyPaths.has(worktreePath)) errors.push(`${label} is dirty at ${worktree.path}. Commit, reject, or remove its work before handoff.`)

    if (worktree.branch === config.canonicalBranch) {
      canonicalPresent = true
      continue
    }
    if (worktree.branch && anchors.has(worktree.branch)) continue
    if (worktree.branch && temporary.has(worktree.branch)) {
      const declaration = temporary.get(worktree.branch)
      if (declaration.removeAfter < today) errors.push(`${worktree.branch} expired on ${declaration.removeAfter}; reconcile and remove it.`)
      if (mergedBranches.has(worktree.branch)) errors.push(`${worktree.branch} is already merged into ${config.canonicalBranch}; remove its worktree and declaration.`)
      continue
    }
    if (!worktree.branch && worktreePath === current && worktree.head === canonicalCommit) {
      canonicalDetachedPresent = true
      continue
    }
    errors.push(`${label} is not the canonical, repository anchor, or a declared temporary worktree.`)
  }

  for (const entry of config.temporaryWorktrees) {
    if (!presentBranches.has(entry.branch)) errors.push(`${entry.branch} is declared temporary but has no worktree; remove the stale declaration.`)
  }
  if (!canonicalPresent && !canonicalDetachedPresent) errors.push(`No worktree is validating the canonical ${config.canonicalBranch} commit.`)
  return errors
}
