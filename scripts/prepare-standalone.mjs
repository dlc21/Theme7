import fs from "node:fs"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { configuredValue } from "./runtime-config-core.mjs"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distDirectory = configuredValue("NEXT_DIST_DIR") ?? ".next"
const standalone = path.join(root, distDirectory, "standalone")
const argumentsList = process.argv.slice(2)
if (argumentsList.some((value) => value !== "--build") || argumentsList.length > 1) throw new Error("Usage: prepare-standalone [--build]")
if (argumentsList[0] === "--build") {
  const nextBin = require.resolve("next/dist/bin/next")
  const result = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1" },
    stdio: "inherit",
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
for (const [source, destination] of [
  [path.join(root, distDirectory, "static"), path.join(standalone, distDirectory, "static")],
  [path.join(root, "recipes"), path.join(standalone, "recipes")],
]) {
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true })
}
