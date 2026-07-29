import { randomUUID } from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"

export function parseEnvFile(input) {
  const values = {}
  for (const line of String(input).split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "")
  }
  return values
}

export async function readJson(file, { missing = null } = {}) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return missing
    throw error
  }
}

export async function writeJson(file, value, { privateFile = false } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: privateFile ? 0o600 : 0o644 })
    if (privateFile) await fsp.chmod(temporary, 0o600).catch(() => undefined)
    await fsp.rename(temporary, file)
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
