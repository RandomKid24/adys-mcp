/**
 * Directory/file names that are skipped while walking the tree.
 *
 * Matching is by path segment: a file or directory is skipped when any segment
 * of its path equals an ignored name. This keeps the walk cheap and predictable
 * without pulling in a glob engine.
 */
export const DEFAULT_IGNORES: readonly string[] = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vercel",
  ".netlify",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "coverage",
  ".nyc_output",
  ".idea",
  ".gradle",
  ".terraform",
  "Pods",
  "DerivedData",
  ".expo",
  ".dart_tool",
  ".pnpm-store",
  ".yarn",
]

export function createIgnore(extra?: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>(DEFAULT_IGNORES)
  for (const entry of extra ?? []) {
    const name = entry.trim().replace(/\/+$/, "")
    if (name) set.add(name)
  }
  return set
}

export function isIgnored(relativePath: string, ignore: ReadonlySet<string>): boolean {
  if (ignore.size === 0) return false
  for (const segment of relativePath.split("/")) {
    if (segment && ignore.has(segment)) return true
  }
  return false
}
