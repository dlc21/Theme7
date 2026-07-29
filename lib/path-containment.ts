import path from "node:path"

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function relativePortablePath(root: string, candidate: string): string {
  return path.relative(path.resolve(root), path.resolve(candidate)).split(path.sep).join("/")
}
