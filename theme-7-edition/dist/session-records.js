import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const HEADER_BYTES = 64 * 1024
function normalized(value, platform = process.platform) { const resolved = path.resolve(value); return platform === "win32" ? resolved.toLowerCase() : resolved }
function sameOrParent(parent, candidate) { const relative = path.relative(normalized(parent), normalized(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) }
export async function readOmpSessionMetadata(file, buffer = Buffer.allocUnsafe(HEADER_BYTES)) {
  const descriptor = await fs.open(file, "r")
  try {
    const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0)
    const records = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/).slice(0, 4).flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] } })
    const header = records.find((record) => record?.type === "session")
    const titleRecord = records.find((record) => ["title", "title_change", "ai-title"].includes(record?.type) && typeof record.title === "string" && record.title.trim()) ?? header
    return typeof header?.id === "string" ? { id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "", timestamp: typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN, file, title: typeof titleRecord?.title === "string" ? titleRecord.title.trim().replace(/\s+/g, " ").slice(0, 120) : null } : null
  } finally { await descriptor.close() }
}
export async function findRecentOmpSession(cwd, notBefore, root = path.join(os.homedir(), ".omp", "agent", "sessions")) {
  const deadline = Date.now() + 2500, candidates = new Map(), buffer = Buffer.allocUnsafe(HEADER_BYTES)
  let files = 0, stopped = false
  async function visit(directory, depth) {
    if (stopped || depth > 3) return
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (Date.now() >= deadline || files >= 2000) { stopped = true; return }
      if (entry.isSymbolicLink()) continue
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(candidate, depth + 1)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files += 1
        try { const metadata = await readOmpSessionMetadata(candidate, buffer); if (metadata && Number.isFinite(metadata.timestamp) && metadata.timestamp >= notBefore && sameOrParent(metadata.cwd, cwd) && /^[A-Za-z0-9._:-]{6,240}$/.test(metadata.id)) candidates.set(metadata.id, metadata) } catch {}
      }
    }
  }
  await visit(root, 0)
  return !stopped && candidates.size === 1 ? [...candidates.values()][0] : null
}

export function decodeOmpActivityRecords(records, fallbackTimestamp) {
  const activity = []
  const header = records.find((item) => item?.type === "session")
  if (header) activity.push({ kind: "session", timestamp: typeof header.timestamp === "string" ? header.timestamp : fallbackTimestamp, title: typeof header.title === "string" && header.title.trim() ? header.title.trim() : "OMP session" })
  let inPlanMode = false
  for (const item of records) {
    if (item?.type !== "mode_change" || typeof item.mode !== "string") continue
    const timestamp = typeof item.timestamp === "string" ? item.timestamp : fallbackTimestamp
    if (item.mode === "plan") {
      inPlanMode = true
      activity.push({ kind: "plan-enter", id: typeof item.id === "string" ? item.id : String(activity.length), timestamp, planFile: item.data && typeof item.data === "object" ? item.data.planFile : undefined })
    } else if (inPlanMode && item.mode === "none") {
      inPlanMode = false
      activity.push({ kind: "plan-exit", id: typeof item.id === "string" ? item.id : String(activity.length), timestamp })
    }
  }
  return activity
}
