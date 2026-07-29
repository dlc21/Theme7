import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import {
  dockerContextFiles,
  DOCKER_ROOT_FILES,
  DOCKER_SCRIPT_FILES,
  DOCKER_SOURCE_DIRECTORIES,
  DOCKER_VENDOR_FILES,
  expectedDockerIgnore,
  isDockerContextExcluded,
  validateDockerfile,
} from "./build-surface-policy.mjs"
import { CONTAINER_RUNTIME_FILES } from "./runtime-files-policy.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const temporary = []

async function contextFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "operator-engine-build-surface-"))
  temporary.push(root)
  for (const relative of [...DOCKER_ROOT_FILES, ...DOCKER_SCRIPT_FILES, ...DOCKER_VENDOR_FILES]) {
    const target = path.join(root, relative)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, relative)
  }
  for (const directory of DOCKER_SOURCE_DIRECTORIES) {
    await fsp.mkdir(path.join(root, directory, "nested"), { recursive: true })
    await fsp.writeFile(path.join(root, directory, "source.ts"), directory)
    await fsp.writeFile(path.join(root, directory, "source.test.ts"), "excluded")
    await fsp.writeFile(path.join(root, directory, "nested", ".env.local"), "excluded")
    await fsp.writeFile(path.join(root, directory, "nested", "state.sqlite-wal"), "excluded")
  }
  return root
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })))
})

describe("build surface policy", () => {
  it("keeps .dockerignore generated from one deny-by-default policy", async () => {
    const actual = (await fsp.readFile(path.join(repositoryRoot, ".dockerignore"), "utf8")).replaceAll("\r\n", "\n")
    expect(actual).toBe(expectedDockerIgnore())
    expect(actual.startsWith("**\n")).toBe(true)
    expect(actual).not.toContain("!scripts/**")
  })

  it("pins repository text to reproducible LF checkouts", async () => {
    const attributes = await fsp.readFile(path.join(repositoryRoot, ".gitattributes"), "utf8")
    expect(attributes).toBe("* text=auto eol=lf\n*.gif binary\n*.png binary\n*.jpg binary\n*.jpeg binary\n*.webp binary\n*.ico binary\n*.woff binary\n*.woff2 binary\n*.tgz binary\n")
  })

  it("pins every external base and disables build and runtime telemetry", async () => {
    const dockerfile = await fsp.readFile(path.join(repositoryRoot, "Dockerfile"), "utf8")
    expect(validateDockerfile(dockerfile)).toEqual({ externalBases: 2 })
    expect(() => validateDockerfile(dockerfile.replace(/@sha256:[a-f0-9]{64}/, ""))).toThrow(/not pinned/)
    expect(() => validateDockerfile(`# syntax=docker/dockerfile:latest\n${dockerfile}`)).toThrow(/mutable external frontend/)
    expect(() => validateDockerfile(dockerfile.replaceAll("NEXT_TELEMETRY_DISABLED=1", "NEXT_TELEMETRY_DISABLED=0"))).toThrow(/telemetry/)
  })

  it("pins OMP in every final image", async () => {
    const dockerfile = await fsp.readFile(path.join(repositoryRoot, "Dockerfile"), "utf8")
    expect(dockerfile).toContain("@oh-my-pi/pi-coding-agent")
    expect(dockerfile).toMatch(/^ARG OMP_VERSION=\d+\.\d+\.\d+$/m)
    expect(() => validateDockerfile(dockerfile.replace(/^ARG OMP_VERSION=.*$/m, "ARG OMP_VERSION=latest"))).toThrow(/OMP_VERSION must have an exact version/)
  })

  it("routes source builds through telemetry-disabled wrappers", async () => {
    const metadata = JSON.parse(await fsp.readFile(path.join(repositoryRoot, "package.json"), "utf8"))
    const prepareSource = await fsp.readFile(path.join(repositoryRoot, "scripts", "prepare-standalone.mjs"), "utf8")
    const runSource = await fsp.readFile(path.join(repositoryRoot, "scripts", "run.mjs"), "utf8")
    expect(metadata.scripts.build).toBe("node scripts/prepare-standalone.mjs --build")
    expect(prepareSource).toContain('NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1"')
    expect(runSource).toContain('process.env.NEXT_TELEMETRY_DISABLED ??= "1"')
  })

  it("includes every container runtime file but excludes development and review tooling", () => {
    for (const relative of CONTAINER_RUNTIME_FILES) {
      if (relative.startsWith("scripts/")) expect(DOCKER_SCRIPT_FILES).toContain(relative)
      else expect(DOCKER_ROOT_FILES).toContain(relative)
    }
    expect(DOCKER_SCRIPT_FILES).not.toContain("scripts/doctor.mjs")
    expect(DOCKER_SCRIPT_FILES).not.toContain("scripts/local-train.mjs")
    expect(DOCKER_SCRIPT_FILES).not.toContain("scripts/package-standalone.mjs")
    expect(DOCKER_SCRIPT_FILES).not.toContain("scripts/setup.mjs")
    expect(DOCKER_ROOT_FILES).not.toContain(".env.example")
    expect(DOCKER_ROOT_FILES).not.toContain("AGENTS.md")
    expect(DOCKER_ROOT_FILES).not.toContain("README.md")
    expect(DOCKER_ROOT_FILES).not.toContain("SECURITY.md")
    expect(DOCKER_ROOT_FILES).toContain("proxy.ts")
  })

  it.each([
    "app/route.test.ts",
    "lib/parser.spec.ts",
    "recipes/client-workspace/session.json",
    "public/.operator-engine/state.json",
    "components/.env.local",
    "editions/runtime.sqlite-wal",
    "app/artifacts/review.json",
    "lib/.review-data/result.json",
  ])("excludes ignored or non-build input %s", (relative) => {
    expect(isDockerContextExcluded(relative)).toBe(true)
  })

  it("enumerates only regular allowed context files", async () => {
    const root = await contextFixture()
    const files = dockerContextFiles(root)
    for (const relative of [...DOCKER_ROOT_FILES, ...DOCKER_SCRIPT_FILES, ...DOCKER_VENDOR_FILES]) expect(files).toContain(relative)
    for (const directory of DOCKER_SOURCE_DIRECTORIES) {
      expect(files).toContain(`${directory}/source.ts`)
      expect(files).not.toContain(`${directory}/source.test.ts`)
      expect(files).not.toContain(`${directory}/nested/.env.local`)
      expect(files).not.toContain(`${directory}/nested/state.sqlite-wal`)
    }
  })
})
