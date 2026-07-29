import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { inspectGitRepository } from "@/lib/git"

const temporary: string[] = []
function temp(): string { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-git-")); temporary.push(directory); return directory }
afterEach(() => temporary.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })))

describe("read-only Git lane inspection", () => {
  it("reports a plain directory honestly", async () => {
    await expect(inspectGitRepository(temp())).resolves.toMatchObject({ state: "plain-directory", changedFiles: [], commits: [] })
  })

  it("reports branch, changes, commits, and registered worktrees without writing", async () => {
    const directory = temp()
    execFileSync("git", ["init", "-b", "main"], { cwd: directory })
    execFileSync("git", ["config", "user.email", "client@example.invalid"], { cwd: directory })
    execFileSync("git", ["config", "user.name", "Client test"], { cwd: directory })
    fs.writeFileSync(path.join(directory, "README.md"), "one\n")
    execFileSync("git", ["add", "README.md"], { cwd: directory })
    execFileSync("git", ["commit", "-m", "Initial lane"], { cwd: directory })
    fs.appendFileSync(path.join(directory, "README.md"), "two\n")
    fs.writeFileSync(path.join(directory, "NOW.md"), "next\n")

    const before = fs.readFileSync(path.join(directory, "README.md"), "utf8")
    const snapshot = await inspectGitRepository(directory)

    expect(snapshot.state).toBe("repository")
    expect(snapshot.branch).toBe("main")
    expect(snapshot.changedFiles.map((file) => file.path)).toEqual(expect.arrayContaining(["README.md", "NOW.md"]))
    expect(snapshot.commits[0]?.subject).toBe("Initial lane")
    expect(snapshot.worktrees).toHaveLength(1)
    expect(fs.readFileSync(path.join(directory, "README.md"), "utf8")).toBe(before)
  })
})
