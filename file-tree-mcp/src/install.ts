// `npx -y github:RandomKid24/adys-mcp install` — registers the server in every MCP client found.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"

const NAME = "file-tree"
const CMD = "npx"
const ARGS = ["-y", "github:RandomKid24/adys-mcp"]
const home = homedir()

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
        execFileSync("claude", ["mcp", "add", "--scope", "user", NAME, "--", CMD, ...ARGS], { stdio: "pipe" })
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
      return patchJson(file, "mcp", { type: "local", command: [CMD, ...ARGS], enabled: true })
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
