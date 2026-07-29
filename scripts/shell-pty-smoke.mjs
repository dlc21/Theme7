import { createRequire } from "node:module"

import { resolveShell } from "./harness-adapters.mjs"

const require = createRequire(import.meta.url)
const pty = require("@lydell/node-pty")
const shell = resolveShell()
if (!shell) throw new Error("No native shell found.")
const marker = "OPERATOR_ENGINE_SHELL_OK"
const args = process.platform === "win32"
  ? ["-NoLogo", "-NoProfile", "-Command", `Write-Output ${marker}`]
  : ["-lc", `printf ${marker}`]
await new Promise((resolve, reject) => {
  const child = pty.spawn(shell.executable, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
  let output = ""
  let settled = false
  const finish = (error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try { child.kill() } catch { /* already exited */ }
    error ? reject(error) : resolve()
  }
  const timer = setTimeout(() => finish(new Error(`Shell PTY smoke timed out: ${output}`)), 10_000)
  child.onData((data) => {
    output += data
    if (output.includes(marker)) finish()
  })
  child.onExit(({ exitCode }) => {
    if (!output.includes(marker)) finish(new Error(`Shell PTY smoke failed with ${exitCode}: ${output}`))
  })
})
process.stdout.write("Native Shell PTY smoke passed.\n")
