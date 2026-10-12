// Run: node src/mcpctl.test.ts   (uses a throwaway HOME, touches nothing real)
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "mcpctl-"))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, ".cursor"))
mkdirSync(join(home, ".codex"))
writeFileSync(join(home, ".cursor/mcp.json"), '{"mcpServers":{"keep":{"command":"x"}}}')
writeFileSync(join(home, ".codex/config.toml"), "[x]\na=1\n")

const { mcpctl } = await import("./mcpctl.ts")
const log = console.log
console.log = () => {}
assert.equal(mcpctl(["add", "t1", "--env", "K=V", "--", "node", "s.js"]), 0)
const cursor = JSON.parse(readFileSync(join(home, ".cursor/mcp.json"), "utf8"))
assert.deepEqual(cursor.mcpServers.t1, { command: "node", args: ["s.js"], env: { K: "V" } })
assert.ok(cursor.mcpServers.keep, "existing servers are preserved")
assert.match(readFileSync(join(home, ".codex/config.toml"), "utf8"), /\[mcp_servers\.t1\.env\]/)
assert.equal(mcpctl(["remove", "t1"]), 0)
assert.equal(JSON.parse(readFileSync(join(home, ".cursor/mcp.json"), "utf8")).mcpServers.t1, undefined)
assert.equal(readFileSync(join(home, ".codex/config.toml"), "utf8").includes("t1"), false)
assert.equal(mcpctl(["add", "bad name", "--", "x"]), 2)
console.log = log
console.log("mcpctl ok")
