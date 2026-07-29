#!/usr/bin/env node

import { execFileSync } from "node:child_process"

const allowedName = "David Lin-Clark"
const allowedEmail = "240863360+dlc21@users.noreply.github.com"
const commits = execFileSync("git", ["rev-list", "HEAD"], { encoding: "utf8", windowsHide: true })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)

if (commits.length === 0) throw new Error("Commit identity policy requires at least one commit.")

for (const commit of commits) {
  const record = execFileSync("git", ["show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%B", commit], { encoding: "utf8", windowsHide: true })
  const [authorName, authorEmail, committerName, committerEmail, ...messageLines] = record.split(/\r?\n/)
  if (authorName !== allowedName || committerName !== allowedName || authorEmail !== allowedEmail || committerEmail !== allowedEmail) {
    throw new Error(`Commit ${commit} is not authored and committed solely by ${allowedName}.`)
  }
  if (messageLines.some((line) => /^\s*co-authored-by\s*:/i.test(line))) {
    throw new Error(`Commit ${commit} contains a co-author trailer.`)
  }
}

process.stdout.write(`Commit identity policy passed: ${commits.length} commit${commits.length === 1 ? "" : "s"}; ${allowedName} only.\n`)
