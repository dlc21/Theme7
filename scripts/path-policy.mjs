import path from "node:path"

export function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function relativePortablePath(root, candidate) {
  return path.relative(path.resolve(root), path.resolve(candidate)).split(path.sep).join("/")
}
