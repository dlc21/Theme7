const MISSING_THEME_MESSAGE = "Theme 7 was selected but is not installed."
const nativeImport = (specifier) => import(/* webpackIgnore: true */ specifier)
export function theme7Selected(environment = process.env) {
  return environment.OPERATOR_ENGINE_DISTRIBUTION === "theme-7"
}

function missingTheme(error) {
  return error instanceof Error && error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("theme-7")
}

async function optionalImport(specifier, required) {
  try {
    // Theme 7 is an optional runtime package and is intentionally absent from stock artifacts.
    return await nativeImport(specifier)
  } catch (error) {
    if (!missingTheme(error)) throw error
    if (required) throw new Error(MISSING_THEME_MESSAGE)
    return null
  }
}

export async function loadTheme7ServerAdapter({ required }) {
  const [distribution, server] = await Promise.all([
    optionalImport("theme-7", required),
    optionalImport("theme-7/server-adapter", required),
  ])
  if (!distribution || !server) return null
  return { distribution: distribution.ompTheme7, adapter: server.ompAdapter, resolveOmp: server.resolveOmp }
}

export async function loadTheme7SessionRecords({ required }) {
  return optionalImport("theme-7/session-records", required)
}
