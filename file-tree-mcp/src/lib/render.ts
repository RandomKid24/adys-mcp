import type { EditedFile } from "./edited.ts"
import type { TreeNode } from "./scan.ts"

export interface Row {
  kind: "dir" | "file"
  name: string
  path: string
  depth: number
  /** Box-drawing prefix, e.g. `│ ├ `. */
  guide: string
  edited?: EditedFile
  /** Directory has children and can therefore be expanded/collapsed. */
  expandable?: boolean
  /** Directory is currently open. */
  open?: boolean
}

export interface FlattenResult {
  rows: Row[]
  truncated: boolean
}

/** Decides whether a directory at a given depth is currently expanded. */
export type IsOpen = (path: string, depth: number) => boolean

/**
 * Flatten a tree into indented rows with box-drawing guides. Children are only
 * emitted for directories that {@link IsOpen} reports as expanded.
 */
export function flattenTree(
  nodes: readonly TreeNode[],
  edited: ReadonlyMap<string, EditedFile>,
  isOpen: IsOpen,
  maxRows: number,
): FlattenResult {
  const rows: Row[] = []
  let truncated = false

  const walk = (list: readonly TreeNode[], prefix: string, depth: number): void => {
    for (let index = 0; index < list.length; index += 1) {
      if (rows.length >= maxRows) {
        truncated = true
        return
      }
      const node = list[index]
      if (!node) continue
      const last = index === list.length - 1
      const isDirectory = node.type === "directory"
      const children = node.children ?? []
      const open = isDirectory && children.length > 0 && isOpen(node.path, depth)

      const row: Row = {
        kind: isDirectory ? "dir" : "file",
        name: node.name,
        path: node.path,
        depth,
        guide: prefix + (last ? "└ " : "├ "),
      }
      if (isDirectory) {
        row.expandable = children.length > 0
        row.open = open
      }
      const hit = edited.get(node.path)
      if (hit) row.edited = hit
      rows.push(row)

      if (open) walk(children, prefix + (last ? "  " : "│ "), depth + 1)
    }
  }

  walk(nodes, "", 1)
  return { rows, truncated }
}

/** Flat, most-recently-edited-first list of the files a session touched. */
export function flattenEdited(edited: ReadonlyMap<string, EditedFile>, maxRows: number): FlattenResult {
  const files = [...edited.values()].sort((left, right) => right.last - left.last || left.path.localeCompare(right.path))
  const rows: Row[] = []

  for (const file of files) {
    if (rows.length >= maxRows) return { rows, truncated: true }
    rows.push({ kind: "file", name: file.path, path: file.path, depth: 1, guide: "", edited: file })
  }

  return { rows, truncated: false }
}

export function marker(file: EditedFile): string {
  const glyph = file.status === "added" ? "+" : file.status === "deleted" ? "−" : "●"
  return file.count > 1 ? `${glyph}${file.count}` : glyph
}
