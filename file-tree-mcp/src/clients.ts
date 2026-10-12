// MCP client registry: how to add, remove and list a server in each client's own config format.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"

export interface Server {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface Client {
  id: string
  name: string
  /** Config location whose existence means "this client is installed". */
  detect: string
  add(server: Server): string
  remove(name: string): string
  /** Server names, or undefined when the config can't be read. */
  list(): string[] | undefined
}

export const win = platform() === "win32"
export const home = homedir()

/** Server names go into TOML headers and a RegExp, so keep them to a safe alphabet. */
export const validName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)

/** Windows can't spawn `npx` & co. directly (they are .cmd shims); route them through cmd. */
export function launch(server: Server): { command: string; args: string[] } {
  if (win && ["npx", "npm", "pnpm", "yarn", "uvx"].includes(server.command)) return { command: "cmd", args: ["/c", server.command, ...server.args] }
  return { command: server.command, args: server.args }
}

const appSupport = platform() === "darwin" ? join(home, "Library/Application Support") : win ? (process.env.APPDATA ?? join(home, "AppData/Roaming")) : join(home, ".config")

const backup = (file: string): void => {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`)
}

// ------------------------------------------------------------------ JSON configs

function readJson(file: string): any | "invalid" {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, "utf8") || "{}")
  } catch {
    return "invalid"
  }
}

const INVALID = "skipped (config has comments/invalid JSON — edit it manually)"

export function patchJson(file: string, key: string, name: string, entry: unknown | undefined): string {
  const data = readJson(file)
  if (data === "invalid") return INVALID
  const bucket = (data[key] ??= {})
  const remove = entry === undefined
  if (remove ? !(name in bucket) : name in bucket) return remove ? "not installed" : "already installed"
  if (!existsSync(file)) mkdirSync(dirname(file), { recursive: true })
  backup(file)
  if (remove) delete bucket[name]
  else bucket[name] = entry
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
  return remove ? "removed" : "installed"
}

function jsonClient(id: string, name: string, detect: string, file: string, key = "mcpServers", shape?: (s: Server) => unknown): Client {
  const entry = (s: Server) => {
    if (shape) return shape(s)
    const { command, args } = launch(s)
    return { command, args, ...(s.env ? { env: s.env } : {}) }
  }
  return {
    id,
    name,
    detect,
    add: (s) => patchJson(file, key, s.name, entry(s)),
    remove: (n) => patchJson(file, key, n, undefined),
    list() {
      const data = readJson(file)
      return data === "invalid" ? undefined : Object.keys(data[key] ?? {})
    },
  }
}

// ------------------------------------------------------------------ Claude Code (its own CLI)

function claude(...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: win }) }
  } catch (error) {
    return { ok: false, out: String((error as any).stderr || (error as Error).message) }
  }
}

const claudeCode: Client = {
  id: "claude-code",
  name: "Claude Code",
  detect: join(home, ".claude"),
  add(s) {
    const { command, args } = launch(s)
    const env = Object.entries(s.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])
    const r = claude("mcp", "add", "--scope", "user", ...env, s.name, "--", command, ...args)
    return r.ok ? "installed" : /already exists/i.test(r.out) ? "already installed" : "failed (is `claude` on PATH?)"
  },
  remove(name) {
    const r = claude("mcp", "remove", "--scope", "user", name)
    return r.ok ? "removed" : /not found|no .*server found/i.test(r.out) ? "not installed" : "failed (is `claude` on PATH?)"
  },
  list() {
    const r = claude("mcp", "list")
    if (!r.ok) return undefined
    return [...r.out.matchAll(/^([^\s:]+):\s/gm)].map((m) => m[1]!)
  },
}

// ------------------------------------------------------------------ Codex (TOML)

const codexFile = join(home, ".codex/config.toml")
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const codex: Client = {
  id: "codex",
  name: "Codex",
  detect: join(home, ".codex"),
  add(s) {
    const text = existsSync(codexFile) ? readFileSync(codexFile, "utf8") : ""
    if (text.includes(`[mcp_servers.${s.name}]`)) return "already installed"
    backup(codexFile)
    const { command, args } = launch(s)
    let block = `\n[mcp_servers.${s.name}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`
    if (s.env && Object.keys(s.env).length) {
      block += `\n[mcp_servers.${s.name}.env]\n${Object.entries(s.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}\n`).join("")}`
    }
    mkdirSync(dirname(codexFile), { recursive: true })
    writeFileSync(codexFile, text + block)
    return "installed"
  },
  remove(name) {
    const text = existsSync(codexFile) ? readFileSync(codexFile, "utf8") : ""
    if (!text.includes(`[mcp_servers.${name}]`)) return "not installed"
    backup(codexFile)
    // the server's table and its .env subtable: header, then every line that isn't a new [table]
    const table = (suffix: string) => new RegExp(`\\n?\\[mcp_servers\\.${escapeRe(name)}${suffix}\\]\\n(?:[^\\[\\n].*\\n?)*`)
    writeFileSync(codexFile, text.replace(table(""), "").replace(table("\\.env"), ""))
    return "removed"
  },
  list() {
    const text = existsSync(codexFile) ? readFileSync(codexFile, "utf8") : ""
    return [...text.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((m) => m[1]!)
  },
}

// ------------------------------------------------------------------ OpenCode

const opencodeDir = join(home, ".config/opencode")
export const opencodeFile = (): string => (existsSync(join(opencodeDir, "opencode.json")) ? join(opencodeDir, "opencode.json") : join(opencodeDir, "opencode.jsonc"))

const opencode: Client = {
  id: "opencode",
  name: "OpenCode",
  detect: opencodeDir,
  add: (s) =>
    patchJson(opencodeFile(), "mcp", s.name, {
      type: "local",
      command: (({ command, args }) => [command, ...args])(launch(s)),
      enabled: true,
      ...(s.env ? { environment: s.env } : {}),
    }),
  remove: (n) => patchJson(opencodeFile(), "mcp", n, undefined),
  list() {
    const data = readJson(opencodeFile())
    return data === "invalid" ? undefined : Object.keys(data.mcp ?? {})
  },
}

export const clients: Client[] = [
  claudeCode,
  jsonClient("claude-desktop", "Claude Desktop", join(appSupport, "Claude"), join(appSupport, "Claude/claude_desktop_config.json")),
  jsonClient("cursor", "Cursor", join(home, ".cursor"), join(home, ".cursor/mcp.json")),
  jsonClient("windsurf", "Windsurf", join(home, ".codeium/windsurf"), join(home, ".codeium/windsurf/mcp_config.json")),
  jsonClient("kiro", "Kiro", join(home, ".kiro"), join(home, ".kiro/settings/mcp.json")),
  jsonClient("antigravity", "Antigravity", join(home, ".gemini/antigravity"), join(home, ".gemini/antigravity/mcp_config.json")),
  jsonClient("gemini", "Gemini CLI", join(home, ".gemini"), join(home, ".gemini/settings.json")),
  opencode,
  codex,
]

export const detected = (only?: string[]): Client[] =>
  clients.filter((c) => existsSync(c.detect) && (!only || only.includes(c.id)))
