import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { isIgnored } from "./ignore.ts"
import { baseName } from "./paths.ts"

export interface TreeNode {
  name: string
  /** Path relative to the project root, without a trailing slash. */
  path: string
  type: "file" | "directory"
  children?: TreeNode[]
}

export interface ScanOptions {
  /** How many directory levels below the root to walk. */
  maxDepth: number
  /** Stop once this many entries have been collected. */
  maxRows: number
  /** Maximum concurrent `file.list` requests. */
  concurrency: number
  ignore: ReadonlySet<string>
}

export interface ScanResult {
  nodes: TreeNode[]
  truncated: boolean
  count: number
}

function createLimiter(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const release = (): void => {
    active -= 1
    queue.shift()?.()
  }
  return async <Value>(task: () => Promise<Value>): Promise<Value> => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve))
    active += 1
    try {
      return await task()
    } finally {
      release()
    }
  }
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

function cloneNode(node: TreeNode): TreeNode {
  return {
    name: node.name,
    path: node.path,
    type: node.type,
    children: node.children?.map(cloneNode),
  }
}

function insertPath(nodes: TreeNode[], path: string): void {
  const segments = path.split("/").filter(Boolean)
  if (segments.length === 0) return

  let level = nodes
  for (let index = 0; index < segments.length - 1; index += 1) {
    const name = segments[index]
    if (!name) return
    const dirPath = segments.slice(0, index + 1).join("/")
    let dir = level.find((node) => node.type === "directory" && node.name === name)
    if (!dir) {
      dir = { name, path: dirPath, type: "directory", children: [] }
      level.push(dir)
    }
    if (!dir.children) dir.children = []
    level = dir.children
  }

  const leaf = segments[segments.length - 1]
  if (!leaf) return
  if (!level.some((node) => node.type === "file" && node.name === leaf)) {
    level.push({ name: leaf, path, type: "file" })
  }
}

/**
 * Copy the scanned tree and splice in placeholder file nodes for paths that
 * were deleted during the session, so removals stay visible in the tree even
 * though the file no longer exists on disk.
 */
export function mergeDeletedFiles(nodes: readonly TreeNode[], deleted: Iterable<string>): TreeNode[] {
  const paths = [...new Set(deleted)]
  if (paths.length === 0) return nodes as TreeNode[]

  const clone = nodes.map(cloneNode)
  for (const path of paths) insertPath(clone, path)

  const sortDeep = (list: TreeNode[]): TreeNode[] => {
    sortNodes(list)
    for (const node of list) {
      if (node.children) sortDeep(node.children)
    }
    return list
  }
  return sortDeep(clone)
}

/**
 * Walk the project tree through the OpenCode filesystem API, one `file.list`
 * call per directory. Using the server API (instead of `node:fs`) means the
 * plugin works against remote servers and needs no filesystem permissions.
 */
export async function scanTree(
  client: OpenCodeClient,
  location: LocationRef,
  options: ScanOptions,
): Promise<ScanResult> {
  const limit = createLimiter(options.concurrency)
  let count = 0
  let truncated = false

  const list = async (path: string | undefined): Promise<ReadonlyArray<{ path: string; type: "file" | "directory" }>> => {
    try {
      const response = await client.file.list({ location, path })
      return response.data
    } catch {
      return []
    }
  }

  const walk = async (dir: string, depth: number): Promise<TreeNode[]> => {
    if (depth > options.maxDepth) return []
    const entries = await limit(() => list(dir || undefined))

    const results = await Promise.all(
      entries.map(async (entry): Promise<TreeNode | undefined> => {
        if (count >= options.maxRows) {
          truncated = true
          return undefined
        }
        const relative = entry.path.replace(/\/+$/, "")
        if (!relative || isIgnored(relative, options.ignore)) return undefined

        const name = baseName(relative)
        count += 1
        if (entry.type === "directory") {
          const children = await walk(relative, depth + 1)
          return { name, path: relative, type: "directory", children }
        }
        return { name, path: relative, type: "file" }
      }),
    )

    return sortNodes(results.filter((node): node is TreeNode => node !== undefined))
  }

  const nodes = await walk("", 1)
  return { nodes, truncated, count }
}
