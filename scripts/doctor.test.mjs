import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate a doctor test port."))
      server.close(() => resolve(address.port))
    })
  })
}

describe("native doctor", () => {
  it("warns for missing optional agent harnesses while keeping Shell usable", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-doctor-"))
    const webPort = await freePort()
    const terminalPort = await freePort()
    try {
      const missing = path.join(temporary, "definitely-missing-harness")
      const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "doctor.mjs")], {
        cwd: temporary,
        env: {
          ...process.env,
          OPERATOR_ENGINE_DATA_DIR: path.join(temporary, "data"),
          OPERATOR_ENGINE_DB_PATH: path.join(temporary, "data", "theme7.sqlite"),
          OPERATOR_ENGINE_WORKSPACE_ROOT: path.join(temporary, "workspace"),
          OPERATOR_ENGINE_PORT: String(webPort),
          OPERATOR_ENGINE_TERMINAL_PORT: String(terminalPort),
          OPERATOR_ENGINE_OMP_BIN: missing,
          OPERATOR_ENGINE_CODEX_BIN: missing,
          OPERATOR_ENGINE_DISTRIBUTION: "stock",
        },
        encoding: "utf8",
        windowsHide: true,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).not.toContain("harness:omp")
      expect(result.stdout).toMatch(/WARN harness:codex: (?:missing|broken)/)
      expect(result.stdout).toMatch(/PASS harness:shell: available/)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  }, 15_000)
  it("diagnoses unavailable and unknown distribution selections", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-doctor-distribution-"))
    const missing = path.join(temporary, "definitely-missing-harness")
    const baseEnv = {
      ...process.env,
      OPERATOR_ENGINE_DATA_DIR: path.join(temporary, "data"),
      OPERATOR_ENGINE_DB_PATH: path.join(temporary, "data", "theme7.sqlite"),
      OPERATOR_ENGINE_WORKSPACE_ROOT: path.join(temporary, "workspace"),
      OPERATOR_ENGINE_PORT: String(await freePort()),
      OPERATOR_ENGINE_TERMINAL_PORT: String(await freePort()),
      OPERATOR_ENGINE_OMP_BIN: missing,
      OPERATOR_ENGINE_CODEX_BIN: missing,
      OPERATOR_ENGINE_DISTRIBUTION: "stock",
    }
    try {
      const selected = spawnSync(process.execPath, [path.join(import.meta.dirname, "doctor.mjs")], {
        cwd: temporary,
        env: { ...baseEnv, OPERATOR_ENGINE_DISTRIBUTION: "theme-7" },
        encoding: "utf8",
        windowsHide: true,
      })
      expect(selected.status).toBe(1)
      expect(selected.stdout).toContain("FAIL distribution: Theme Seven was selected but OMP is unavailable.")
      expect(selected.stdout).toMatch(/WARN harness:omp: (?:missing|broken)/)
      expect(selected.stdout).not.toContain("harness:codex")

      const unknown = spawnSync(process.execPath, [path.join(import.meta.dirname, "doctor.mjs")], {
        cwd: temporary,
        env: { ...baseEnv, OPERATOR_ENGINE_DISTRIBUTION: "unknown" },
        encoding: "utf8",
        windowsHide: true,
      })
      expect(unknown.status).toBe(1)
      expect(unknown.stdout).toContain("FAIL distribution: Unknown OPERATOR_ENGINE_DISTRIBUTION selection.")
      expect(unknown.stdout).toMatch(/WARN harness:codex: (?:missing|broken)/)
      expect(unknown.stdout).not.toContain("harness:omp")
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  }, 20_000)
  it("does not apply POSIX mode bits to a Windows config file", async () => {
    if (process.platform !== "win32") return
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-doctor-windows-config-"))
    const missing = path.join(temporary, "definitely-missing-harness")
    fs.writeFileSync(path.join(temporary, ".env.local"), "OPERATOR_ENGINE_TERMINAL_SECRET=placeholder\n", { mode: 0o666 })
    try {
      const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "doctor.mjs")], {
        cwd: temporary,
        env: {
          ...process.env,
          OPERATOR_ENGINE_DATA_DIR: path.join(temporary, "data"),
          OPERATOR_ENGINE_DB_PATH: path.join(temporary, "data", "theme7.sqlite"),
          OPERATOR_ENGINE_WORKSPACE_ROOT: path.join(temporary, "workspace"),
          OPERATOR_ENGINE_PORT: String(await freePort()),
          OPERATOR_ENGINE_TERMINAL_PORT: String(await freePort()),
          OPERATOR_ENGINE_CODEX_BIN: missing,
          OPERATOR_ENGINE_DISTRIBUTION: "stock",
        },
        encoding: "utf8",
        windowsHide: true,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain("WARN secret-hygiene: config exists; POSIX mode check is not applicable on Windows")
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  }, 15_000)
})
