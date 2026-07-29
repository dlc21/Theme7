import { spawn } from "node:child_process"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import type { GitLaneSnapshot } from "@/lib/types"

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 512 * 1024,
  })
  return result.stdout.replace(/[\r\n]+$/, "")
}

function changedFiles(output: string): GitLaneSnapshot["changedFiles"] {
  const tokens = output.split("\0").filter(Boolean)
  const files: GitLaneSnapshot["changedFiles"] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const status = token.slice(0, 2)
    let filename = token.slice(3)
    if ((status.includes("R") || status.includes("C")) && tokens[index + 1]) filename = `${filename} -> ${tokens[++index]}`
    files.push({ path: filename, status })
  }
  return files
}

function commits(output: string): GitLaneSnapshot["commits"] {
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [hash, shortHash, timestamp, ...subject] = line.split("\u001f")
    return hash && shortHash && timestamp ? [{ hash, shortHash, timestamp, subject: subject.join("\u001f") }] : []
  })
}

function worktrees(output: string): GitLaneSnapshot["worktrees"] {
  const result: GitLaneSnapshot["worktrees"] = []
  let current: GitLaneSnapshot["worktrees"][number] | null = null
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) result.push(current)
      current = { path: line.slice("worktree ".length) }
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length)
    else if (current && line.startsWith("branch ")) current.branch = line.slice("branch refs/heads/".length)
    else if (current && line === "bare") current.bare = true
    else if (current && line === "detached") current.detached = true
  }
  if (current) result.push(current)
  return result
}

export async function inspectGitRepository(cwd: string): Promise<GitLaneSnapshot> {
  try {
    await git(cwd, ["rev-parse", "--show-toplevel"])
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Git inspection failed."
    if (/not a git repository/i.test(message)) return { state: "plain-directory", changedFiles: [], commits: [], worktrees: [] }
    return { state: "unavailable", changedFiles: [], commits: [], worktrees: [], reason: /ENOENT|not recognized|cannot find/i.test(message) ? "Git is not installed or is unavailable." : "Git state could not be read." }
  }

  try {
    const [branchResult, statusResult, logResult, worktreeResult] = await Promise.all([
      git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "Detached HEAD"),
      git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(cwd, ["log", "-5", "--format=%H%x1f%h%x1f%cI%x1f%s"]).catch(() => ""),
      git(cwd, ["worktree", "list", "--porcelain"]),
    ])
    return {
      state: "repository",
      branch: branchResult || "Detached HEAD",
      changedFiles: changedFiles(statusResult),
      commits: commits(logResult),
      worktrees: worktrees(worktreeResult),
    }
  } catch {
    return { state: "unavailable", changedFiles: [], commits: [], worktrees: [], reason: "Git state could not be read." }
  }
}

export async function initializeGitRepository(cwd: string): Promise<{ created: boolean }> {
  try {
    const stat = await fs.stat(path.join(cwd, ".git"))
    if (stat.isDirectory() || stat.isFile()) return { created: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["init"], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.once("error", () => reject(new Error("Git is required to initialize this lane.")))
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || "git init failed.")))
  })
  return { created: true }
}
