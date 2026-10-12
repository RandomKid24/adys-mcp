// `npx -y github:RandomKid24/adys-mcp install|uninstall` — (un)registers our servers in every MCP client found.
import { execFileSync } from "node:child_process"
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { detected, home, opencodeFile, type Server, win } from "./clients.ts"

const PACKAGE = "github:RandomKid24/adys-mcp"
const MOD = "file-tree-pane"
const PKG_DIR = dirname(fileURLToPath(import.meta.url))

/** Our three servers all come from this package; the second argument picks one. */
export const OURS: Server[] = [
  { name: "file-tree", command: "npx", args: ["-y", PACKAGE] },
  { name: "project-memory", command: "npx", args: ["-y", PACKAGE, "memory"] },
  { name: "env-doctor", command: "npx", args: ["-y", PACKAGE, "doctor"] },
]

/** Copy the sidebar plugin next to the OpenCode config and list it under `plugins` (or undo that). */
function patchPlugin(configFile: string, remove: boolean): string {
  const target = join(home, ".config/opencode/file-tree-plugin")
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

/** The /tree pane mod for Claude Code draws in the terminal itself, so it costs no tokens. */
function claudePane(remove: boolean): string {
  const run = (...args: string[]): string => {
    try {
      execFileSync("claude", args, { stdio: "pipe", shell: win })
      return ""
    } catch (error) {
      return String((error as any).stderr || (error as Error).message)
    }
  }
  const outcome = (err: string, done: string): string =>
    !err ? done : /already (exists|installed)/i.test(err) ? "already installed" : /not found|not installed/i.test(err) ? "not installed" : "failed (is `claude` on PATH?)"
  if (remove) return outcome(run("plugin", "uninstall", `${MOD}@adys-mcp`), "removed")
  run("plugin", "marketplace", "add", "RandomKid24/adys-mcp")
  return outcome(run("plugin", "install", `${MOD}@adys-mcp`), "installed")
}

export function install(remove = false): void {
  const found = detected()
  if (found.length === 0) console.log("No supported MCP clients detected.")
  for (const client of found) {
    const parts = OURS.filter((s) => !(client.id === "opencode" && s.name === "file-tree")) // the plugin replaces it there
      .map((s) => `${s.name} ${remove ? client.remove(s.name) : client.add(s)}`)
    if (client.id === "opencode") parts.unshift(`sidebar plugin ${patchPlugin(opencodeFile(), remove)}`)
    if (client.id === "claude-code") parts.push(`/tree pane ${claudePane(remove)}`)
    console.log(`${client.name.padEnd(15)} ${parts.join("; ")}`)
  }
  if (found.length) console.log(`\nRestart your client(s) to ${remove ? "unload" : "load"} the servers.`)
}
