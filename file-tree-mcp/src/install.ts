// `npx -y github:RandomKid24/adys-mcp install` — registers the server in every MCP client found.
import { execFileSync } from "node:child_process"
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const NAME = "file-tree"
const win = platform() === "win32"
// Windows can't spawn `npx` directly (it's npx.cmd); route through cmd.
const [CMD, ...ARGS] = [...(win ? ["cmd", "/c"] : []), "npx", "-y", "github:RandomKid24/adys-mcp"]
const home = homedir()
const PKG_DIR = dirname(fileURLToPath(import.meta.url))

/** Merge into a JSON config at `keyPath`. Skips (returns a reason) when the file isn't plain JSON. */
function patchJson(file: string, keyPath: string, entry: unknown): string {
  let data: any = {}
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8") || "{}")
    } catch {
      return "skipped (config has comments/invalid JSON — add it manually)"
    }
    copyFileSync(file, `${file}.bak`)
  } else mkdirSync(dirname(file), { recursive: true })
  const bucket = (data[keyPath] ??= {})
  if (bucket[NAME]) return "already installed"
  bucket[NAME] = entry
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
  return "installed"
}

/** Copy the sidebar plugin next to the OpenCode config and list it under `plugins`. */
function installPlugin(dir: string, configFile: string): string {
  if (!existsSync(join(PKG_DIR, "tui.tsx"))) return "skipped (plugin sources not in this package)"
  const target = join(dir, "file-tree-plugin")
  mkdirSync(target, { recursive: true })
  for (const item of ["index.ts", "tui.tsx", "src"]) cpSync(join(PKG_DIR, item), join(target, item), { recursive: true })
  let data: any
  try {
    data = JSON.parse(readFileSync(configFile, "utf8") || "{}")
  } catch {
    return `copied to ${target} — add it to "plugins" manually`
  }
  const plugins: unknown[] = (data.plugins ??= [])
  if (plugins.includes(target)) return "updated"
  plugins.push(target)
  writeFileSync(configFile, JSON.stringify(data, null, 2) + "\n")
  return "installed"
}

const stdio = { command: CMD, args: ARGS }
const appSupport =
  platform() === "darwin"
    ? join(home, "Library/Application Support")
    : platform() === "win32"
      ? (process.env.APPDATA ?? join(home, "AppData/Roaming"))
      : join(home, ".config")

interface Client {
  name: string
  detect: string
  run: () => string
}

const clients: Client[] = [
  {
    name: "Claude Code",
    detect: join(home, ".claude"),
    run() {
      try {
        execFileSync("claude", ["mcp", "add", "--scope", "user", NAME, "--", CMD, ...ARGS], { stdio: "pipe", shell: win })
        return "installed"
      } catch (error) {
        return /already exists/i.test(String((error as any).stderr)) ? "already installed" : "failed (is `claude` on PATH?)"
      }
    },
  },
  {
    name: "Claude Desktop",
    detect: join(appSupport, "Claude"),
    run: () => patchJson(join(appSupport, "Claude/claude_desktop_config.json"), "mcpServers", stdio),
  },
  { name: "Cursor", detect: join(home, ".cursor"), run: () => patchJson(join(home, ".cursor/mcp.json"), "mcpServers", stdio) },
  {
    name: "Windsurf",
    detect: join(home, ".codeium/windsurf"),
    run: () => patchJson(join(home, ".codeium/windsurf/mcp_config.json"), "mcpServers", stdio),
  },
  { name: "Gemini CLI", detect: join(home, ".gemini"), run: () => patchJson(join(home, ".gemini/settings.json"), "mcpServers", stdio) },
  {
    name: "OpenCode",
    detect: join(home, ".config/opencode"),
    run() {
      const dir = join(home, ".config/opencode")
      const file = existsSync(join(dir, "opencode.json")) ? join(dir, "opencode.json") : join(dir, "opencode.jsonc")
      // The plugin already provides the sidebar and the edited-files tool, so no MCP entry here.
      return `sidebar plugin ${installPlugin(dir, file)}`
    },
  },
  {
    name: "Codex",
    detect: join(home, ".codex"),
    run() {
      const file = join(home, ".codex/config.toml")
      const text = existsSync(file) ? readFileSync(file, "utf8") : ""
      if (text.includes(`[mcp_servers.${NAME}]`)) return "already installed"
      if (text) copyFileSync(file, `${file}.bak`)
      const block = `\n[mcp_servers.${NAME}]\ncommand = "${CMD}"\nargs = ${JSON.stringify(ARGS)}\n`
      writeFileSync(file, text + block)
      return "installed"
    },
  },
]

export function install(): void {
  const found = clients.filter((c) => existsSync(c.detect))
  if (found.length === 0) console.log("No supported MCP clients detected.")
  for (const c of found) console.log(`${c.name.padEnd(15)} ${c.run()}`)
  if (found.length) console.log("\nRestart your client(s) to load `file-tree`.")
}
