// project-memory MCP server: a shared, git-aware memory graph for any MCP client.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { existsSync, statSync, watch } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { createIgnore, isIgnored } from "../lib/ignore.ts"
import { describe, forget, link, neighbors, recordSession, remember, search } from "./core.ts"
import { graphPath, headSha, loadGraph, memoryRoot, saveGraph, staleMap } from "./store.ts"

const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], ...(isError ? { isError } : {}) })

export const VERSION = "0.2.1"

/** What this server sees: the same text for `memory status` (human) and the `memory_status` tool (AI). */
export function status(): string {
  const root = memoryRoot()
  const file = graphPath(root)
  const graph = loadGraph(root)
  let watching = root === homedir() || dirname(root) === root ? "OFF — root is your home/filesystem root, not a project (start your client inside the project or set MEMORY_ROOT)" : "yes"
  try {
    watch(root, { recursive: true }).close()
  } catch (error) {
    watching = `NO — ${(error as Error).message}`
  }
  const sessions = graph.nodes.filter((n) => n.kind === "session")
  const last = existsSync(file) ? new Date(statSync(file).mtimeMs).toISOString() : "never written"
  return [
    `project-memory ${VERSION}`,
    `working directory : ${process.cwd()}`,
    `project root used : ${root}${process.env.MEMORY_ROOT ? " (MEMORY_ROOT)" : ""}`,
    `memory file       : ${file} (${existsSync(file) ? "exists" : "does not exist yet"})`,
    `last written      : ${last}`,
    `nodes / edges     : ${graph.nodes.length} / ${graph.edges.length}  (${sessions.length} session, ${graph.nodes.filter((n) => n.kind === "file").length} file, ${graph.nodes.filter((n) => ["decision", "note", "task"].includes(n.kind)).length} decision/note/task)`,
    `file watcher      : ${watching}`,
    `git               : ${headSha(root) ? "repo, HEAD " + headSha(root)!.slice(0, 7) : "no git repo here (stale checks off)"}`,
  ].join("\n")
}

const INSTRUCTIONS =
  "Project memory. Before re-deriving why something is built a certain way, call `recall`. " +
  "When a real decision is made (a choice between options, a constraint discovered), call `remember` with the WHY. " +
  "At the end of a substantial piece of work, call `log_session` with a one-line summary. " +
  "Files changed while this server runs are already recorded automatically on today's session node."

/**
 * Records files that change under `root` while the server runs onto today's session
 * node, so memory fills itself in every client with no hook and no model call.
 */
/** Returns `flush`, which writes any pending batch immediately (called on exit so a short session loses nothing). */
export function watchChanges(root: string, log?: (message: string) => void): () => void {
  const ignore = createIgnore([".memory"])
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const files = [...pending].slice(0, 200).filter((rel) => {
      try {
        return statSync(join(root, rel)).isFile() // skips deletions and directories
      } catch {
        return false
      }
    })
    pending.clear()
    if (files.length === 0) return
    try {
      const graph = loadGraph(root)
      const now = Date.now()
      recordSession(graph, new Date(now).toISOString().slice(0, 10), files, now, undefined, headSha(root))
      saveGraph(root, graph)
      log?.(`recorded ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}`)
    } catch (error) {
      log?.(`could not save: ${(error as Error).message}`) // never take the server down over memory capture
    }
  }

  try {
    watch(root, { recursive: true }, (_event, name) => {
      if (!name) return
      const rel = String(name).replace(/\\/g, "/")
      if (isIgnored(rel, ignore) || rel.split("/").pop()!.startsWith(".env")) return
      pending.add(rel)
      timer ??= setTimeout(flush, 3000)
    }).on("error", () => {})
  } catch {
    // recursive watching unsupported here: the explicit tools still work
  }
  return flush
}

export async function serve(): Promise<void> {
  const root = memoryRoot()
  const server = new McpServer({ name: "project-memory", version: VERSION }, { instructions: INSTRUCTIONS })

  server.registerTool(
    "memory_status",
    { description: "Report where project memory is stored, how much it holds, and whether automatic file capture is running. Use when memory looks empty.", inputSchema: {} },
    async () => text(status()),
  )

  server.registerTool(
    "remember",
    {
      description:
        "Save something worth keeping about this project: a decision (with WHY and what was rejected), a note, or a task. Link it to the files it concerns so it can be found and checked for staleness later. Call this when a decision is made, not for routine edits.",
      inputSchema: {
        kind: z.enum(["decision", "note", "task"]),
        title: z.string().min(3).describe("One line, e.g. 'Use JWT in httpOnly cookies'."),
        why: z.string().optional().describe("The reasoning — what you'd want to know in 3 months."),
        rejected: z.array(z.string()).optional().describe("Alternatives considered and not chosen."),
        files: z.array(z.string()).optional().describe("Project-relative paths this concerns."),
        tags: z.array(z.string()).optional(),
      },
    },
    async (input) => {
      const graph = loadGraph(root)
      const node = remember(graph, { ...input, at: Date.now(), sha: headSha(root) })
      saveGraph(root, graph)
      return text(`Saved ${node.kind} ${node.id}.`)
    },
  )

  server.registerTool(
    "recall",
    {
      description:
        "Search project memory (decisions, notes, tasks, sessions) and get back only the matching memories with their linked files — ask this before re-deriving why something is the way it is. Flags memories whose files changed since.",
      inputSchema: { query: z.string().min(2), limit: z.number().int().min(1).max(20).optional() },
    },
    async ({ query, limit = 5 }) => {
      const graph = loadGraph(root)
      const hits = search(graph, query, limit)
      if (hits.length === 0) return text(`No memories match "${query}".`)
      const stale = staleMap(root, graph)
      return text(hits.map((n) => describe(graph, n, stale)).join("\n\n"))
    },
  )

  server.registerTool(
    "file_memory",
    {
      description: "Everything remembered about one file: decisions that affect it and sessions that touched it, newest first.",
      inputSchema: { path: z.string().describe("Project-relative path.") },
    },
    async ({ path }) => {
      const graph = loadGraph(root)
      const file = graph.nodes.find((n) => n.id === `file:${path}`)
      if (!file) return text(`Nothing remembered about ${path}.`)
      const stale = staleMap(root, graph)
      const related = neighbors(graph, file.id).sort((a, b) => b.at - a.at)
      return text(related.map((n) => describe(graph, n, stale)).join("\n\n") || `Nothing remembered about ${path}.`)
    },
  )

  server.registerTool(
    "log_session",
    {
      description:
        "Record what this session did (one short summary, plus the files touched). Merges into today's session node. Call once near the end of a work session.",
      inputSchema: { summary: z.string().min(3), files: z.array(z.string()).optional() },
    },
    async ({ summary, files = [] }) => {
      const graph = loadGraph(root)
      const now = Date.now()
      const node = recordSession(graph, new Date(now).toISOString().slice(0, 10), files, now, summary, headSha(root))
      saveGraph(root, graph)
      return text(`Logged to ${node.id}.`)
    },
  )

  server.registerTool(
    "link_memories",
    {
      description: "Connect two memories (ids from recall), e.g. a task that continues a session, or a decision that supersedes another.",
      inputSchema: { from: z.string(), to: z.string(), type: z.string().optional().describe("e.g. relates, supersedes, continues") },
    },
    async ({ from, to, type = "relates" }) => {
      const graph = loadGraph(root)
      if (![from, to].every((id) => graph.nodes.some((n) => n.id === id))) return text("Unknown id — use ids from recall.", true)
      link(graph, from, to, type)
      saveGraph(root, graph)
      return text(`Linked ${from} → ${to} (${type}).`)
    },
  )

  server.registerTool(
    "stale_memories",
    { description: "Memories whose linked files have changed since they were recorded — candidates to re-check or forget.", inputSchema: {} },
    async () => {
      const graph = loadGraph(root)
      const stale = staleMap(root, graph)
      const nodes = graph.nodes.filter((n) => stale[n.id])
      return text(nodes.length ? nodes.map((n) => describe(graph, n, stale)).join("\n\n") : "No stale memories.")
    },
  )

  server.registerTool(
    "forget",
    { description: "Delete a memory by id (and its links).", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const graph = loadGraph(root)
      const gone = forget(graph, id)
      if (gone) saveGraph(root, graph)
      return text(gone ? `Forgot ${id}.` : `No memory ${id}.`, !gone)
    },
  )

  await server.connect(new StdioServerTransport())
  // A client that starts the server in $HOME or / is not inside a project; watching that would be huge and private.
  const tooBroad = root === homedir() || dirname(root) === root
  if (existsSync(root) && !tooBroad) {
    const flush = watchChanges(root)
    process.on("exit", flush) // synchronous, so it runs even when the client closes the pipe and we exit
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0))
  }
  console.error(`project-memory ${VERSION}: root=${root} (${tooBroad ? "NOT a project folder - file watcher off; set MEMORY_ROOT" : "file watcher on"})`) // stderr only: stdout is the protocol
}
