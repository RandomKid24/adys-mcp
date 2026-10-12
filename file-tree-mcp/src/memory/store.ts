import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Graph, neighbors, parseGraph } from "./core.ts"

/** Project the memory belongs to: MEMORY_ROOT, else the client's working directory. */
export const memoryRoot = (): string => process.env.MEMORY_ROOT ?? process.cwd()
const graphPath = (root: string): string => join(root, ".memory", "graph.json")

export function loadGraph(root: string): Graph {
  try {
    return parseGraph(readFileSync(graphPath(root), "utf8"))
  } catch {
    return parseGraph(undefined)
  }
}

export function saveGraph(root: string, graph: Graph): void {
  const file = graphPath(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(graph, null, 2) + "\n")
}

function git(root: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}

export const headSha = (root: string): string | undefined => git(root, "rev-parse", "HEAD")

/**
 * Staleness: a memory is "possibly outdated" when files it is linked to have
 * commits after the sha recorded with it. Value = commits touching its files since.
 */
export function staleMap(root: string, graph: Graph): Record<string, number> {
  const out: Record<string, number> = {}
  for (const node of graph.nodes) {
    if (!node.sha || node.kind === "file" || node.kind === "session") continue
    const files = neighbors(graph, node.id).filter((n) => n.kind === "file").map((n) => n.title)
    if (files.length === 0) continue
    const count = Number(git(root, "rev-list", "--count", `${node.sha}..HEAD`, "--", ...files) ?? 0)
    if (count > 0) out[node.id] = count
  }
  return out
}
