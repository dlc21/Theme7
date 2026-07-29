export const publicFiles: readonly string[]
export const STOCK_FORBIDDEN_TEXT: readonly string[]
export type PublicSurfaceFinding = { category: string; path: string; line: number; pattern: string; source: string }
export function scanPublicSurfaceFile(relative: string, source: string): PublicSurfaceFinding[]
export function collectPublicSurfaceLeaks(sources: Record<string, string>): PublicSurfaceFinding[]
export function checkPublicSurface(sources: Record<string, string>): { fileCount: number }
