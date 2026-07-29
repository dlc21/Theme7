import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isPathInside } from "./path-policy.mjs"
import { loadTheme7ServerAdapter, theme7Selected } from "./theme-7-loader.mjs"


const loaded = await loadTheme7ServerAdapter({ required: theme7Selected() })
let adapters = {}
let resources = {}
if (loaded) {
  const packageRoot = fs.realpathSync(fileURLToPath(loaded.distribution.resources.packageRoot))
  const identityExtension = fs.realpathSync(fileURLToPath(loaded.distribution.resources.identityExtension))
  if (!isPathInside(packageRoot, identityExtension)) throw new Error("Reviewed Distribution identity extension escapes its package.")
  adapters = { omp: loaded.adapter }
  resources = { omp: Object.freeze({ identityExtension }) }
}
export const reviewedServerAdapters = Object.freeze(adapters)
export const reviewedServerResources = Object.freeze(resources)
