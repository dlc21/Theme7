import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { checkSourcePackageSurface, expandDeclaredPackageFiles, validateSourcePackageSurface } from "./source-package-policy.mjs"

const root = path.resolve(import.meta.dirname, "..")

describe("source package policy", () => {
  it("matches npm pack dry-run to the declared source surface", () => {
    const result = checkSourcePackageSurface(root)
    expect(result.name).toBe("theme7")
    expect(result.version).toBe("0.1.0")
    expect(result.files).toContain("tests/browser/client.spec.ts")
    expect(result.files).toContain("proxy.ts")
    expect(result.files).toContain("scripts/prove-recovery.mjs")
    expect(result.files).toContain("vendor/theme-7-0.1.0.tgz")
    expect(result.files).toContain("vendor/operator-studio-thread-ingest-core-0.1.0.tgz")
    expect(result.files).toContain("vendor/operator-studio-thread-ingest-adapter-omp-0.1.0.tgz")
  }, 30_000)

  it("pins reviewed dependency install scripts to lockfile versions", () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
    expect(metadata.allowScripts).toEqual({
      "better-sqlite3@12.11.1": true,
    })
    expect(lock.packages["node_modules/better-sqlite3"]).toMatchObject({ version: "12.11.1", hasInstallScript: true })
    expect(lock.packages["node_modules/sharp"]).toMatchObject({ version: "0.35.3" })
    expect(lock.packages["node_modules/sharp"].hasInstallScript).not.toBe(true)
  })

  it("rejects globs and symlinked package inputs", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-package-policy-"))
    try {
      fs.writeFileSync(path.join(temporary, "package.json"), "{}")
      fs.writeFileSync(path.join(temporary, "README.md"), "review")
      fs.writeFileSync(path.join(temporary, "LICENSE"), "review")
      expect(() => expandDeclaredPackageFiles(temporary, ["scripts/*.mjs"])).toThrow("must not use a glob")
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })

  it("rejects undeclared and unsafe packed members", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "operator-engine-package-policy-"))
    try {
      fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ files: ["README.md", "LICENSE"] }))
      fs.writeFileSync(path.join(temporary, "README.md"), "review")
      fs.writeFileSync(path.join(temporary, "LICENSE"), "review")
      const record = { name: "fixture", version: "0.0.0", files: [
        { path: "LICENSE" }, { path: "README.md" }, { path: "package.json" }, { path: ".env.local" },
      ] }
      expect(() => validateSourcePackageSurface(temporary, record)).toThrow(/Unexpected: \.env\.local/)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  })
})
