// `npx -y github:RandomKid24/adys-mcp install|uninstall` — (un)registers the server in every MCP client found.
import { execFileSync } from "node:child_process"
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const NAME = "file-tree"
const win = platform() === "win32"
// Windows can't spawn `npx` directly (it's npx.cmd); route through cmd.
const [CMD, ...ARGS] = [...(win ? ["cmd", "/c"] : []), "npx", "-y", "github:RandomKid24/adys-mcp"]
const home = homedir()
const PKG_DIR = dirname(fileURLToPath(import.meta.url))

/** Add (or remove) our entry under `data[keyPath][NAME]` in a JSON config. */
function patchJson(file: string, keyPath: string, entry: unknown, remove: boolean): string {
  if (!existsSync(file)) {
    if (remove) return "not installed"
    mkdirSync(dirname(file), { recursive: true })
  }
  let data: any = {}
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8") || "{}")
    } catch {
      return "skipped (config has comments/invalid JSON — edit it manually)"
    }
  }
  const bucket = (data[keyPath] ??= {})
  if (remove ? !bucket[NAME] : bucket[NAME]) return remove ? "not installed" : "already installed"
  if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  if (remove) delete bucket[NAME]
  else bucket[NAME] = entry
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
  return remove ? "removed" : "installed"
}

/** Copy the sidebar plugin next to the OpenCode config and list it under `plugins` (or undo that). */
function patchPlugin(dir: string, configFile: string, remove: boolean): string {
  const target = join(dir, "file-tree-plugin")
  let data: any
  try {
    data = JSON.parse(readFileSync(configFile, "utf8") || "{}")
  } catch {
    return remove ? "skipped (config unreadable)" : `copied to ${target} — add it to "plugins" manually`
  }
  const plugins: unknown[] = (data.plugins ??= [])
  const listed = plugins.includes(target)
  if (remove) {
    rmSync(target, { recursive: true, force: true })
    if (!listed) return "not installed"
    data.plugins = plugins.filter((item) => item !== target)
    copyFileSync(configFile, `${configFile}.bak`)
    writeFileSync(configFile, JSON.stringify(data, null, 2) + "\n")
    return "removed"
  }
  if (!existsSync(join(PKG_DIR, "tui.tsx"))) return "skipped (plugin sources not in this package)"
  mkdirSync(target, { recursive: true })
  for (const item of ["index.ts", "tui.tsx", "src"]) cpSync(join(PKG_DIR, item), join(target, item), { recursive: true })
  if (listed) return "updated"
  plugins.push(target)
  copyFileSync(configFile, `${configFile}.bak`)
  writeFileSync(configFile, JSON.stringify(data, null, 2) + "\n")
  return "installed"
}

const stdio = { command: CMD, args: ARGS }
const appSupport =
  platform() === "darwin"
    ? join(home, "Library/Application Support")
    : win
      ? (process.env.APPDATA ?? join(home, "AppData/Roaming"))
      : join(home, ".config")

interface Client {
  name: string
  detect: string
  run: (remove: boolean) => string
}

const mcpServers = (file: string) => (remove: boolean) => patchJson(file, "mcpServers", stdio, remove)

const clients: Client[] = [
  {
    name: "Claude Code",
    detect: join(home, ".claude"),
    run(remove) {
      const args = remove ? ["mcp", "remove", "--scope", "user", NAME] : ["mcp", "add", "--scope", "user", NAME, "--", CMD, ...ARGS]
      try {
        execFileSync("claude", args, { stdio: "pipe", shell: win })
        return remove ? "removed" : "installed"
      } catch (error) {
        const stderr = String((error as any).stderr)
        if (/already exists/i.test(stderr)) return "already installed"
        if (/no .*server found|not found/i.test(stderr)) return "not installed"
        return "failed (is `claude` on PATH?)"
      }
    },
  },
  { name: "Claude Desktop", detect: join(appSupport, "Claude"), run: mcpServers(join(appSupport, "Claude/claude_desktop_config.json")) },
  { name: "Cursor", detect: join(home, ".cursor"), run: mcpServers(join(home, ".cursor/mcp.json")) },
  { name: "Windsurf", detect: join(home, ".codeium/windsurf"), run: mcpServers(join(home, ".codeium/windsurf/mcp_config.json")) },
  { name: "Kiro", detect: join(home, ".kiro"), run: mcpServers(join(home, ".kiro/settings/mcp.json")) },
  {
    name: "Antigravity",
    detect: join(home, ".gemini/antigravity"),
    run: mcpServers(join(home, ".gemini/antigravity/mcp_config.json")),
  },
  { name: "Gemini CLI", detect: join(home, ".gemini"), run: mcpServers(join(home, ".gemini/settings.json")) },
  {
    name: "OpenCode",
    detect: join(home, ".config/opencode"),
    run(remove) {
      const dir = join(home, ".config/opencode")
      const file = existsSync(join(dir, "opencode.json")) ? join(dir, "opencode.json") : join(dir, "opencode.jsonc")
      // The plugin already provides the sidebar and the edited-files tool, so no MCP entry here.
      return `sidebar plugin ${patchPlugin(dir, file, remove)}`
    },
  },
  {
    name: "Codex",
    detect: join(home, ".codex"),
    run(remove) {
      const file = join(home, ".codex/config.toml")
      const text = existsSync(file) ? readFileSync(file, "utf8") : ""
      const header = `[mcp_servers.${NAME}]`
      const has = text.includes(header)
      if (remove ? !has : has) return remove ? "not installed" : "already installed"
      if (text) copyFileSync(file, `${file}.bak`)
      // header line, then every following line that isn't a new [table]
      const block = new RegExp(`\\n?\\[mcp_servers\\.${NAME}\\]\\n(?:[^\\[\\n].*\\n?)*`)
      writeFileSync(file, remove ? text.replace(block, "") : `${text}\n${header}\ncommand = "${CMD}"\nargs = ${JSON.stringify(ARGS)}\n`)
      return remove ? "removed" : "installed"
    },
  },
]

export function install(remove = false): void {
  const found = clients.filter((c) => existsSync(c.detect))
  if (found.length === 0) console.log("No supported MCP clients detected.")
  for (const c of found) console.log(`${c.name.padEnd(15)} ${c.run(remove)}`)
  if (found.length) console.log(`\nRestart your client(s) to ${remove ? "unload" : "load"} \`file-tree\`.`)
}
