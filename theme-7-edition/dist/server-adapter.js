import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

function candidatesOnPath(name, env, platform) {
  const directories = String(env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const extensions = platform === "win32" ? String(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  const names = path.extname(name) ? [name] : extensions.map((extension) => `${name}${extension.toLowerCase()}`)
  return directories.flatMap((directory) => names.map((candidate) => path.join(directory.replace(/^"|"$/g, ""), candidate)))
}
function existingFile(candidates) {
  for (const candidate of candidates) { try { if (fs.statSync(candidate).isFile()) return candidate } catch {} }
  return null
}
export function resolveOmp(env = process.env, platform = process.platform) {
  const configured = env.OPERATOR_ENGINE_OMP_BIN?.trim()
  if (configured) return { executable: configured, prefixArgs: [] }
  if (platform === "win32" && env.LOCALAPPDATA) {
    const local = path.join(env.LOCALAPPDATA, "omp", "omp.exe")
    if (fs.existsSync(local)) return { executable: local, prefixArgs: [] }
  }
  const found = existingFile(candidatesOnPath("omp", env, platform))
  return found ? { executable: found, prefixArgs: [] } : null
}
export async function probeOmp(resolved, timeoutMs = 2500) {
  if (!resolved) return { ok: false, missing: true }
  return new Promise((resolve) => {
    let output = "", settled = false, child, timer
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result) }
    try { child = spawn(resolved.executable, [...resolved.prefixArgs, "--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) }
    catch { return finish({ ok: false, missing: false }) }
    child.stdout?.on("data", (chunk) => { output += String(chunk) })
    child.stderr?.on("data", (chunk) => { output += String(chunk) })
    child.once("error", (error) => finish({ ok: false, missing: error?.code === "ENOENT" }))
    child.once("exit", (code) => finish({ ok: code === 0, missing: false, version: output.trim().split(/\r?\n/)[0]?.slice(0, 120) }))
    timer = setTimeout(() => { child.kill(); finish({ ok: false, missing: false }) }, timeoutMs)
  })
}
export const ompAdapter = {
  id: "omp", label: "OMP", supportsGuidance: true,
  resolveExecutable: resolveOmp,
  probe: probeOmp,
  installHelp(platform = process.platform) {
    return platform === "win32"
      ? { command: "irm https://omp.sh/install.ps1 | iex", docs: "https://github.com/can1357/oh-my-pi", note: "Review and run the official installer yourself; it does not edit Theme7 credentials." }
      : { command: "curl -fsSL https://omp.sh/install | sh", docs: "https://github.com/can1357/oh-my-pi", note: "Review and run the official installer yourself; it does not edit Theme7 credentials." }
  },
  buildLaunch({ executable, resumeSessionId, resumePicker, systemPrompt, trustedIdentityExtension }) {
    const args = resumeSessionId ? ["--resume", resumeSessionId] : resumePicker ? ["--resume"] : []
    if (trustedIdentityExtension) args.push(`--extension=${trustedIdentityExtension}`)
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt)
    return { executable: executable.executable ?? executable, args: [...(executable.prefixArgs ?? []), ...args] }
  },
}
