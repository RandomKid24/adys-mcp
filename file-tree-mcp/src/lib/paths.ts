/** Path helpers shared by the tree walker and the edited-file tracker. */

export function normalizeRoot(root: string): string {
  const normalized = root.replace(/\\/g, "/")
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
}

/**
 * Turn a path reported by the agent (usually absolute, sometimes a `file://`
 * URI) into a path relative to the project root. Returns `undefined` for paths
 * that are empty, equal to the root, or outside the project.
 */
export function toRelative(root: string, path: string): string | undefined {
  let value = path.trim()
  if (!value) return undefined
  value = value.replace(/\\/g, "/")

  if (value.startsWith("file://")) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
    } catch {
      return undefined
    }
  }

  const base = normalizeRoot(root)
  if (value.startsWith("/")) {
    if (value === base) return undefined
    if (value.startsWith(`${base}/`)) value = value.slice(base.length + 1)
    else return undefined
  }

  value = value.replace(/^\.\//, "").replace(/\/+$/, "")
  return value || undefined
}

export function baseName(relativePath: string): string {
  const index = relativePath.lastIndexOf("/")
  return index === -1 ? relativePath : relativePath.slice(index + 1)
}

export function joinRelative(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}
