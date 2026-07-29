import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { reviewedServerAdapters } from "./distribution-adapters.mjs"

const WINDOWS_TARGET = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" }
const WINDOWS_PACKAGE = { x64: "@openai/codex-win32-x64", arm64: "@openai/codex-win32-arm64" }

function candidatesOnPath(name, env = process.env, platform = process.platform) {
  const directories = String(env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const extensions = platform === "win32" ? String(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  const names = path.extname(name) ? [name] : extensions.map((extension) => `${name}${extension.toLowerCase()}`)
  return directories.flatMap((directory) => names.map((candidate) => path.join(directory.replace(/^"|"$/g, ""), candidate)))
}

function existingFile(candidates) {
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* continue */ }
  }
  return null
}

function resolveCodexLaunch(candidate) {
  if (/\.(?:c|m)?js$/i.test(candidate)) return { executable: process.execPath, prefixArgs: [candidate] }
  if (!/\.(?:cmd|bat)$/i.test(candidate)) return { executable: candidate, prefixArgs: [] }
  const codexJs = path.join(path.dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js")
  const triple = WINDOWS_TARGET[process.arch]
  const packageName = WINDOWS_PACKAGE[process.arch]
  const root = path.resolve(path.dirname(codexJs), "..")
  const native = triple && packageName ? existingFile([
    path.join(root, "node_modules", packageName, "vendor", triple, "bin", "codex.exe"),
    path.join(root, "vendor", triple, "bin", "codex.exe"),
  ]) : null
  if (native) return { executable: native, prefixArgs: [] }
  if (fs.existsSync(codexJs)) return { executable: process.execPath, prefixArgs: [codexJs] }
  return { executable: candidate, prefixArgs: [] }
}


export function resolveCodex(env = process.env) {
  const configured = env.OPERATOR_ENGINE_CODEX_BIN?.trim() || env.CODEX_BIN?.trim()
  const found = configured || existingFile(candidatesOnPath("codex", env)) ||
    (process.platform === "darwin" && fs.existsSync("/Applications/Codex.app/Contents/Resources/codex")
      ? "/Applications/Codex.app/Contents/Resources/codex" : null)
  return found ? resolveCodexLaunch(found) : null
}

export function resolveShell(env = process.env) {
  if (process.platform === "win32") {
    const pwsh = existingFile(candidatesOnPath("pwsh", env))
    if (pwsh) return { executable: pwsh, prefixArgs: ["-NoLogo"], versionArgs: ["--version"] }
    const powershell = existingFile(candidatesOnPath("powershell", env)) ||
      (env.SystemRoot ? existingFile([path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]) : null)
    return powershell ? {
      executable: powershell,
      prefixArgs: ["-NoLogo"],
      versionArgs: ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    } : null
  }
  const configured = env.SHELL?.trim()
  const found = (configured && fs.existsSync(configured) ? configured : null) ||
    existingFile(["/bin/zsh", "/bin/bash", "/bin/sh", ...candidatesOnPath("zsh", env), ...candidatesOnPath("bash", env), ...candidatesOnPath("sh", env)])
  return found ? { executable: found, prefixArgs: [], versionArgs: ["--version"] } : null
}

export async function probeResolved(resolved, timeoutMs = 2500) {
  if (!resolved) return { ok: false, missing: true }
  return new Promise((resolve) => {
    const args = resolved.versionArgs ?? [...resolved.prefixArgs, "--version"]
    let output = ""
    let settled = false
    let child
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    try {
      child = spawn(resolved.executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch { return finish({ ok: false, missing: false }) }
    child.stdout?.on("data", (chunk) => { output += String(chunk) })
    child.stderr?.on("data", (chunk) => { output += String(chunk) })
    child.once("error", (error) => finish({ ok: false, missing: error?.code === "ENOENT" }))
    child.once("exit", (code) => finish({ ok: code === 0, missing: false, version: output.trim().split(/\r?\n/)[0]?.slice(0, 120) }))
    timer = setTimeout(() => { child.kill(); finish({ ok: false, missing: false }) }, timeoutMs)
  })
}

const ompAdapter = reviewedServerAdapters.omp
const stockAdapters = {
  codex: {
    id: "codex", label: "Codex", supportsGuidance: true,
    resolve: resolveCodex,
    help: "Install @openai/codex, Codex.app, or set OPERATOR_ENGINE_CODEX_BIN.",
    command({ systemPrompt, resumeSessionId }) { const resolved = resolveCodex(); if (!resolved) throw new Error("Codex is not installed."); return { executable: resolved.executable, args: [...resolved.prefixArgs, "--no-alt-screen", ...(resumeSessionId ? ["resume", resumeSessionId] : []), ...(systemPrompt ? ["-c", `developer_instructions=${JSON.stringify(systemPrompt)}`] : [])] } },
  },
  shell: {
    id: "shell", label: "Shell", supportsGuidance: false,
    resolve: resolveShell,
    help: "Install PowerShell 7, Windows PowerShell, zsh, bash, or sh.",
    command() { const resolved = resolveShell(); if (!resolved) throw new Error("No native shell was found."); return { executable: resolved.executable, args: resolved.prefixArgs } },
  },
}
export const harnessAdapters = ompAdapter ? {
  omp: {
    id: ompAdapter.id,
    label: ompAdapter.label,
    supportsGuidance: ompAdapter.supportsGuidance,
    resolve: (env = process.env) => ompAdapter.resolveExecutable(env, process.platform),
    help: "Install OMP or set OPERATOR_ENGINE_OMP_BIN.",
    command({ systemPrompt, resumeSessionId, resumePicker, identityExtension }) {
      const executable = ompAdapter.resolveExecutable(process.env, process.platform)
      if (!executable) throw new Error("OMP is not installed.")
      return ompAdapter.buildLaunch({ executable, cwd: process.cwd(), resumeSessionId, resumePicker, systemPrompt, trustedIdentityExtension: identityExtension })
    },
  },
  ...stockAdapters,
} : stockAdapters

export function harnessInstallHelp(id, platform = process.platform) {
  if (id === "codex") return { command: "npm install --global @openai/codex", docs: "https://developers.openai.com/codex/cli/", note: "Installs the Codex CLI globally; authenticate inside the terminal." }
  if (id === "omp") return ompAdapter?.installHelp(platform) ?? { command: "", docs: "", note: "Install the Theme 7 package before configuring OMP." }
  return { command: "", docs: "https://learn.microsoft.com/powershell/", note: "Use the native Shell adapter; no agent install is required." }
}

export async function detectHarnesses() {
  return Promise.all(Object.values(harnessAdapters).map(async (adapter) => {
    const probe = await probeResolved(adapter.resolve())
    return {
      id: adapter.id,
      label: adapter.label,
      supportsGuidance: adapter.supportsGuidance,
      state: probe.ok ? "available" : probe.missing ? "missing" : "broken",
      ...(probe.version ? { version: probe.version } : {}),
      ...(!probe.ok ? { help: adapter.help } : {}),
    }
  }))
}
