// One command to add / remove / list any MCP server across every client:
//   npx -y github:RandomKid24/adys-mcp add context7
//   npx -y github:RandomKid24/adys-mcp add mytool -- npx -y some-mcp --flag
//   npx -y github:RandomKid24/adys-mcp add remote-tool --url https://example.com/mcp
import { clients, type Client, detected, type Server, validName } from "./clients.ts"
import { OURS } from "./install.ts"

/** Well-known servers by short name. Commands are from each project's docs; pass `-- <cmd>` to override. */
const CATALOG: Record<string, { server: Omit<Server, "name">; about: string }> = {
  context7: { server: { command: "npx", args: ["-y", "@upstash/context7-mcp"] }, about: "up-to-date library docs for the model" },
  "sequential-thinking": { server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] }, about: "structured step-by-step reasoning tool" },
  memory: { server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }, about: "simple knowledge-graph memory (see project-memory for the git-aware one)" },
  playwright: { server: { command: "npx", args: ["-y", "@playwright/mcp@latest"] }, about: "browser automation" },
  fetch: { server: { command: "uvx", args: ["mcp-server-fetch"] }, about: "fetch web pages as markdown (needs uv)" },
  ...Object.fromEntries(OURS.map((s) => [s.name, { server: { command: s.command, args: s.args }, about: "from this package" }])),
}

const USAGE = `usage:
  add <name> [--client a,b] [--env KEY=VAL | --env KEY] [--dry-run] [-- <command> [args...]]
  add <name> --url <https://remote-mcp>        (bridged with mcp-remote, works in every client)
  remove <name> [--client a,b]
  list                                          which servers are in which client
  catalog                                       short names you can add without a command
clients: ${clients.map((c) => c.id).join(", ")}`

interface Parsed {
  name?: string
  command?: string[]
  url?: string
  only?: string[]
  env: Record<string, string>
  dry: boolean
}

function parse(argv: string[]): Parsed | string {
  const out: Parsed = { env: {}, dry: false }
  const split = argv.indexOf("--")
  const flags = split === -1 ? argv : argv.slice(0, split)
  if (split !== -1) out.command = argv.slice(split + 1)
  for (let i = 0; i < flags.length; i++) {
    const a = flags[i]!
    if (a === "--dry-run") out.dry = true
    else if (a === "--client") out.only = (flags[++i] ?? "").split(",").filter(Boolean)
    else if (a === "--url") out.url = flags[++i]
    else if (a === "--env") {
      const pair = flags[++i] ?? ""
      const eq = pair.indexOf("=")
      const key = eq === -1 ? pair : pair.slice(0, eq)
      const value = eq === -1 ? process.env[key] : pair.slice(eq + 1)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `bad --env name: ${key}`
      if (value === undefined) return `--env ${key}: not set in your shell; use KEY=VALUE`
      out.env[key] = value
    } else if (a.startsWith("--")) return `unknown option ${a}`
    else if (!out.name) out.name = a
    else return `unexpected argument ${a}`
  }
  if (out.only) {
    const bad = out.only.filter((id) => !clients.some((c) => c.id === id))
    if (bad.length) return `unknown client: ${bad.join(", ")}`
  }
  return out
}

function targets(only?: string[]): Client[] | undefined {
  const list = detected(only)
  if (list.length === 0) {
    console.log(only ? `None of ${only.join(", ")} is installed.` : "No supported MCP clients detected.")
    return undefined
  }
  return list
}

function resolve(p: Parsed): Server | string {
  const name = p.name!
  if (p.url) {
    if (!/^https?:\/\//.test(p.url)) return "--url must start with http:// or https://"
    return { name, command: "npx", args: ["-y", "mcp-remote", p.url], env: undefined }
  }
  if (p.command?.length) return { name, command: p.command[0]!, args: p.command.slice(1) }
  const known = CATALOG[name]
  if (known) return { name, ...known.server }
  return `"${name}" is not in the catalog — give a command: add ${name} -- <command> [args...]`
}

export function mcpctl(argv: string[]): number {
  const [sub, ...rest] = argv
  if (sub === "catalog") {
    for (const [name, { server, about }] of Object.entries(CATALOG)) console.log(`${name.padEnd(20)} ${about}\n${"".padEnd(20)} ${server.command} ${server.args.join(" ")}`)
    return 0
  }

  if (sub === "list") {
    const found = detected()
    const rows = found.map((c) => ({ c, names: c.list() }))
    const all = [...new Set(rows.flatMap((r) => r.names ?? []))].sort()
    if (all.length === 0) return console.log("No MCP servers found."), 0
    const width = Math.max(...all.map((n) => n.length), 6) + 2
    console.log("".padEnd(width) + rows.map((r) => r.c.id.padEnd(15)).join(""))
    for (const name of all) console.log(name.padEnd(width) + rows.map((r) => ((r.names ?? []).includes(name) ? "✔" : "·").padEnd(15)).join(""))
    const unreadable = rows.filter((r) => !r.names).map((r) => r.c.name)
    if (unreadable.length) console.log(`\ncould not read: ${unreadable.join(", ")}`)
    return 0
  }

  if (sub === "add" || sub === "remove") {
    const p = parse(rest)
    if (typeof p === "string") return console.error(`${p}\n\n${USAGE}`), 2
    if (!p.name) return console.error(USAGE), 2
    if (!validName(p.name)) return console.error("name: letters, digits, - and _ only (max 64)"), 2
    const list = targets(p.only)
    if (!list) return 1

    if (sub === "remove") {
      for (const c of list) console.log(`${c.name.padEnd(15)} ${p.dry ? "would remove" : c.remove(p.name)}`)
      return 0
    }

    const server = resolve(p)
    if (typeof server === "string") return console.error(server), 2
    if (Object.keys(p.env).length) server.env = p.env
    if (server.env) console.log("note: env values are written in plain text into each client's config file.")
    const results = list.map((c) => ({ c, r: p.dry ? `would add ${server.name}: ${server.command} ${server.args.join(" ")}` : c.add(server) }))
    for (const { c, r } of results) console.log(`${c.name.padEnd(15)} ${r}`)
    if (results.some(({ r }) => r === "installed")) console.log("\nRestart your client(s) to load it. Undo: remove " + server.name)
    return 0
  }

  console.error(USAGE)
  return sub ? 2 : 0
}
