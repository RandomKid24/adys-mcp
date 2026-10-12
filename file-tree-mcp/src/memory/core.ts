// Pure graph logic (no node imports) so the MCP server, the CLI and the OpenCode plugin share it.
export type Kind = "decision" | "note" | "task" | "session" | "file"

export interface MNode {
  id: string
  kind: Kind
  title: string
  /** The reasoning behind a decision. */
  why?: string
  /** Options that were considered and not taken. */
  rejected?: string[]
  tags?: string[]
  /** Epoch ms of creation. */
  at: number
  /** git HEAD when recorded; lets us tell when linked files have moved on. */
  sha?: string
}

export interface MEdge {
  from: string
  to: string
  type: string
}

export interface Graph {
  version: 1
  nodes: MNode[]
  edges: MEdge[]
}

export const emptyGraph = (): Graph => ({ version: 1, nodes: [], edges: [] })

export function parseGraph(text: string | undefined): Graph {
  if (!text) return emptyGraph()
  try {
    const data = JSON.parse(text)
    if (Array.isArray(data?.nodes) && Array.isArray(data?.edges)) return { version: 1, nodes: data.nodes, edges: data.edges }
  } catch {
    // fall through: a corrupt file starts a fresh graph rather than crashing the tool
  }
  return emptyGraph()
}

export const fileId = (path: string): string => `file:${path}`

export function newId(kind: Kind, at: number): string {
  return `${kind[0]}_${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function ensureFile(graph: Graph, path: string, at: number): string {
  const id = fileId(path)
  if (!graph.nodes.some((n) => n.id === id)) graph.nodes.push({ id, kind: "file", title: path, at })
  return id
}

export function link(graph: Graph, from: string, to: string, type: string): void {
  if (!graph.edges.some((e) => e.from === from && e.to === to && e.type === type)) graph.edges.push({ from, to, type })
}

export interface Remember {
  kind: "decision" | "note" | "task"
  title: string
  why?: string
  rejected?: string[]
  files?: string[]
  tags?: string[]
  at: number
  sha?: string
}

export function remember(graph: Graph, input: Remember): MNode {
  const node: MNode = { id: newId(input.kind, input.at), kind: input.kind, title: input.title, at: input.at }
  if (input.why) node.why = input.why
  if (input.rejected?.length) node.rejected = input.rejected
  if (input.tags?.length) node.tags = input.tags
  if (input.sha) node.sha = input.sha
  graph.nodes.push(node)
  for (const path of input.files ?? []) link(graph, node.id, ensureFile(graph, path, input.at), "affects")
  return node
}

/** One session node per day; later calls merge their files into it. */
export function recordSession(graph: Graph, day: string, files: readonly string[], at: number, summary?: string, sha?: string): MNode {
  const id = `session:${day}`
  let node = graph.nodes.find((n) => n.id === id)
  if (!node) {
    node = { id, kind: "session", title: `Session ${day}`, at }
    graph.nodes.push(node)
  }
  if (summary) node.why = node.why ? `${node.why}\n${summary}` : summary
  if (sha) node.sha = sha
  for (const path of files) link(graph, id, ensureFile(graph, path, at), "touched")
  return node
}

export function neighbors(graph: Graph, id: string): MNode[] {
  const ids = new Set<string>()
  for (const e of graph.edges) {
    if (e.from === id) ids.add(e.to)
    else if (e.to === id) ids.add(e.from)
  }
  return graph.nodes.filter((n) => ids.has(n.id))
}

export function forget(graph: Graph, id: string): boolean {
  const before = graph.nodes.length
  graph.nodes = graph.nodes.filter((n) => n.id !== id)
  graph.edges = graph.edges.filter((e) => e.from !== id && e.to !== id)
  return graph.nodes.length < before
}

/** Rank memories (not file nodes) by how many query words hit title/why/tags/linked files. */
export function search(graph: Graph, query: string, limit: number): MNode[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1)
  if (words.length === 0) return []
  const score = (node: MNode): number => {
    const text = [node.title, node.why, ...(node.tags ?? []), ...neighbors(graph, node.id).map((n) => n.title)]
      .join(" ")
      .toLowerCase()
    return words.reduce((sum, w) => sum + (text.includes(w) ? 1 : 0), 0)
  }
  return graph.nodes
    .filter((n) => n.kind !== "file")
    .map((n) => ({ n, s: score(n) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.n.at - a.n.at)
    .slice(0, limit)
    .map((x) => x.n)
}

export function describe(graph: Graph, node: MNode, stale: Record<string, number>): string {
  const files = neighbors(graph, node.id).filter((n) => n.kind === "file").map((n) => n.title)
  const lines = [`[${node.kind}] ${node.title}  (${node.id}, ${new Date(node.at).toISOString().slice(0, 10)})`]
  if (node.why) lines.push(`  why: ${node.why}`)
  if (node.rejected?.length) lines.push(`  rejected: ${node.rejected.join("; ")}`)
  if (files.length) lines.push(`  files: ${files.join(", ")}`)
  if (stale[node.id]) lines.push(`  ⚠ possibly outdated: linked files changed in ${stale[node.id]} commit(s) since this was recorded`)
  return lines.join("\n")
}
