import path from "node:path"
import { fileURLToPath } from "node:url"

import { CONTAINER_RUNTIME_FILES, materializeRuntimeFiles, RUNTIME_FILES } from "./runtime-files-policy.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const argumentsList = process.argv.slice(2)
const [destinationArgument = ".runtime-surface", surface] = argumentsList
if (argumentsList.length > 2 || destinationArgument.startsWith("-") || (surface !== undefined && surface !== "--container")) {
  throw new Error("Usage: materialize-runtime-files [destination] [--container]")
}
const destination = path.resolve(root, destinationArgument)
if (destination === root) throw new Error("Runtime surface destination must not be the source root.")
const files = surface === "--container" ? CONTAINER_RUNTIME_FILES : RUNTIME_FILES
const materialized = await materializeRuntimeFiles(root, destination, { files })
process.stdout.write(`Materialized ${materialized.length} ${surface === "--container" ? "container " : ""}runtime files.\n`)
