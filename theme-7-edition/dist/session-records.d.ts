export type OmpSessionMetadata = { id: string; cwd: string; timestamp: number; file: string; title: string | null }
export type OmpActivityMarker =
  | { kind: "session"; timestamp: string; title: string }
  | { kind: "plan-enter"; id: string; timestamp: string; planFile?: unknown }
  | { kind: "plan-exit"; id: string; timestamp: string }
export function readOmpSessionMetadata(file: string, buffer?: Buffer): Promise<OmpSessionMetadata | null>
export function findRecentOmpSession(cwd: string, notBefore: number, root?: string): Promise<OmpSessionMetadata | null>
export function decodeOmpActivityRecords(records: Array<Record<string, unknown>>, fallbackTimestamp: string): OmpActivityMarker[]
