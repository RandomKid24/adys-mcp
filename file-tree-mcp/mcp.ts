#!/usr/bin/env node
// Universal MCP server: works in any MCP client (Claude Code, Cursor, Codex, ...).
// Usage: file-tree-mcp [projectRoot]   (defaults to the client's cwd)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { relative, resolve } from "node:path"
import { z } from "zod"
import { createIgnore, isIgnored } from "./src/lib/ignore.ts"

if (["add", "remove", "list", "catalog"].includes(process.argv[2] ?? "")) {
  process.exit((await import("./src/mcpctl.ts")).mcpctl(process.argv.slice(2)))
}

if (process.argv[2] === "memory") {
  const memory = await import("./src/memory/server.ts")
  if (process.argv[3] === "status") {
    console.log(memory.status())
    process.exit(0)
  }
  await memory.serve()
  await new Promise<void>((done) => process.stdin.on("close", done)) // run until the client disconnects
  process.exit(0)
}

if (process.argv[2] === "doctor") {
  const doctor = await import("./src/doctor/server.ts")
  if (process.argv[3] === "--report") process.exit(await doctor.report())
  await doctor.serve()
  await new Promise<void>((done) => process.stdin.on("close", done)) // run until the client disconnects
  process.exit(0)
}

if (process.argv[2] === "graph") {
  await (await import("./src/memory/viewer.ts")).viewGraph(Number(process.argv[3]) || undefined)
  await new Promise(() => {})
}

if (process.argv[2] === "install" || process.argv[2] === "uninstall") {
  ;(await import("./src/install.ts")).install(process.argv[2] === "uninstall")
  process.exit(0)
}

const ROOT = resolve(process.argv[2] ?? process.cwd())

interface Change {
  status: "A" | "M" | "D"
  additions?: number
  deletions?: number
}

/** git is the only source of "what changed" an MCP server can see in every client. */
function gitChanges(root: string): Map<string, Change> | string {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.quotepath=off", "-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, // no console window per git call on Windows
    })
  const changes = new Map<string, Change>()
  try {
    for (const line of git("status", "--porcelain", "--untracked-files=all").split("\n")) {
      if (line.length < 4) continue
      const code = line.slice(0, 2)
      const path = line.slice(3).split(" -> ").pop()!
      const status = code.includes("D") ? "D" : code.includes("A") || code === "??" || code.includes("R") ? "A" : "M"
      changes.set(path, { status })
    }
    let numstat = ""
    try {
      numstat = git("diff", "HEAD", "--numstat")
    } catch {
      numstat = git("diff", "--numstat") // no commits yet
    }
    for (const line of numstat.split("\n")) {
      const [add, del, path] = line.split("\t")
      const change = path && changes.get(path)
      if (change && add !== "-") {
        change.additions = Number(add)
        change.deletions = Number(del)
      }
    }
  } catch (error) {
    return `Not a git repository (or git failed) at ${root}: ${(error as Error).message.split("\n")[0]}`
  }
  return changes
}

const stats = (c: Change) => (c.additions === undefined ? "" : `  +${c.additions} -${c.deletions}`)

function renderTree(root: string, maxDepth: number, maxRows: number, extraIgnore: string[]): string {
  const ignore = createIgnore(extraIgnore)
  const changes = gitChanges(root)
  const changed = typeof changes === "string" ? new Map<string, Change>() : changes
  const lines: string[] = []
  let truncated = false

  const walk = (dir: string, rel: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(resolve(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (isIgnored(path, ignore)) continue
      if (lines.length >= maxRows) {
        truncated = true
        return
      }
      const pad = "  ".repeat(depth)
      if (entry.isDirectory()) {
        lines.push(`${pad}${entry.name}/`)
        if (depth + 1 < maxDepth) walk(dir, path, depth + 1)
      } else {
        const c = changed.get(path)
        lines.push(`${pad}${entry.name}${c ? `  [${c.status}]${stats(c)}` : ""}`)
      }
    }
  }
  walk(root, "", 0)
  if (truncated) lines.push(`… truncated at ${maxRows} rows (raise maxRows or lower maxDepth)`)
  return [`${root}`, ...lines].join("\n")
}

/** Resolve a user path inside the project root; refuse anything that escapes it. */
function inRoot(path: string): string {
  const full = resolve(ROOT, path)
  const rel = relative(ROOT, full)
  if (rel.startsWith("..") || resolve(rel) === rel) throw new Error(`Path is outside the project: ${path}`)
  return full
}

function searchFiles(query: string, limit: number, extraIgnore: string[]): string[] {
  const ignore = createIgnore(extraIgnore)
  const needle = query.toLowerCase()
  const hits: string[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(resolve(ROOT, rel), { withFileTypes: true })) {
      if (hits.length >= limit) return
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (isIgnored(path, ignore)) continue
      if (entry.isDirectory()) walk(path)
      else if (path.toLowerCase().includes(needle)) hits.push(path)
    }
  }
  walk("")
  return hits
}

const server = new McpServer({ name: "file-tree-mcp", version: "0.3.0" })

server.registerTool(
  "file_tree",
  {
    description:
      "Project file tree (ignores node_modules, .git, build output). Files with uncommitted git changes are tagged [A]dded / [M]odified / [D]eleted with +N -M line counts.",
    inputSchema: {
      path: z.string().optional().describe("Directory to show. Defaults to the project root."),
      maxDepth: z.number().int().min(1).max(12).optional().describe("Levels below the root (default 4)."),
      maxRows: z.number().int().min(10).max(2000).optional().describe("Row cap (default 160)."),
      ignore: z.array(z.string()).optional().describe("Extra path segments to skip."),
    },
  },
  async ({ path, maxDepth = 4, maxRows = 160, ignore = [] }) => ({
    content: [{ type: "text", text: renderTree(resolve(ROOT, path ?? "."), maxDepth, maxRows, ignore) }],
  }),
)

server.registerTool(
  "edited_files",
  {
    description:
      "List files changed in the working tree (uncommitted, per git) with A/M/D status and +N -M line counts. Answers 'what did the agent change?'.",
    inputSchema: { path: z.string().optional().describe("Repo directory. Defaults to the project root.") },
  },
  async ({ path }) => {
    const result = gitChanges(resolve(ROOT, path ?? "."))
    if (typeof result === "string") return { content: [{ type: "text", text: result }], isError: true }
    const rows = [...result].sort(([a], [b]) => a.localeCompare(b))
    const text = rows.length
      ? `${rows.length} file(s) changed:\n${rows.map(([p, c]) => `${c.status}  ${p}${stats(c)}`).join("\n")}`
      : "No uncommitted changes."
    return { content: [{ type: "text", text }] }
  },
)

server.registerTool(
  "search_files",
  {
    description: "Find project files whose path contains the query (case-insensitive). Skips node_modules, .git and build output.",
    inputSchema: {
      query: z.string().min(1).describe("Part of a file path, e.g. 'auth' or '.test.ts'."),
      maxResults: z.number().int().min(1).max(500).optional().describe("Default 50."),
      ignore: z.array(z.string()).optional().describe("Extra path segments to skip."),
    },
  },
  async ({ query, maxResults = 50, ignore = [] }) => {
    const hits = searchFiles(query, maxResults, ignore)
    return { content: [{ type: "text", text: hits.length ? hits.join("\n") : `No files match "${query}".` }] }
  },
)

server.registerTool(
  "read_file",
  {
    description: "Read a text file inside the project (max 200 KB). Optionally a 1-based inclusive line range.",
    inputSchema: {
      path: z.string().describe("Path relative to the project root."),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    },
  },
  async ({ path, startLine, endLine }) => {
    try {
      const full = inRoot(path)
      if (statSync(full).size > 200 * 1024) throw new Error("File is larger than 200 KB; use a smaller file.")
      const text = readFileSync(full, "utf8")
      if (text.includes("\0")) throw new Error("Binary file.")
      const out = startLine || endLine ? text.split("\n").slice((startLine ?? 1) - 1, endLine).join("\n") : text
      return { content: [{ type: "text", text: out }] }
    } catch (error) {
      return { content: [{ type: "text", text: (error as Error).message }], isError: true }
    }
  },
)

await server.connect(new StdioServerTransport())
