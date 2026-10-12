/**
 * Smoke test for the tree walker, edited-file tracker and renderer against a real
 * running OpenCode service.
 *
 *   npm run smoke
 *
 * It discovers the local service, walks the project tree, then inspects a few
 * recent sessions and prints the files they edited. If no service is running the
 * script exits successfully with a notice, so it stays safe in CI.
 */
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { resolveConfig } from "../src/lib/config.ts"
import { collectEdited, type EditedFile } from "../src/lib/edited.ts"
import { fetchSessionMessages } from "../src/lib/messages.ts"
import { flattenTree } from "../src/lib/render.ts"
import { scanTree } from "../src/lib/scan.ts"

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

const endpoint = await Service.discover()
if (!endpoint) {
  console.log("No local OpenCode service is running; skipping smoke test.")
  process.exit(0)
}

const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const location = await client.location.get()
const root = location.directory

section("service")
console.log(`url: ${endpoint.url}`)
console.log(`root: ${root}`)

const config = resolveConfig({ maxDepth: 3, maxRows: 120, concurrency: 8 })

section("scanTree")
const started = Date.now()
const scan = await scanTree(
  client,
  { directory: root },
  { maxDepth: config.maxDepth, maxRows: config.maxRows, concurrency: config.concurrency, ignore: config.ignore },
)
console.log(`nodes: ${scan.count}  truncated: ${scan.truncated}  in ${Date.now() - started}ms`)

const flat = flattenTree(scan.nodes, new Map(), (_path, depth) => depth < 2, 30)
for (const row of flat.rows) {
  console.log(`${row.guide}${row.kind === "dir" ? `${row.name}/` : row.name}`)
  if (row.depth >= 2 && flat.rows.indexOf(row) > 24) break
}

section("collectEdited")
const sessions = await client.session.list({ limit: 5 })
console.log(`recent sessions: ${sessions.data.length}`)
for (const session of sessions.data.slice(0, 3)) {
  const messages = await fetchSessionMessages(client, session.id)
  const edited = collectEdited(messages, root)
  const files = [...edited.values()].sort((left, right) => right.last - left.last)
  console.log(`- ${session.id}  "${session.title ?? "(untitled)"}"  ${files.length} edited`)
  for (const file of files.slice(0, 5)) {
    const stats = file.counted ? ` +${file.additions} -${file.deletions}` : ""
    console.log(`    ${status(file)} ${file.path}${stats}${file.count > 1 ? ` (×${file.count})` : ""}`)
  }
}

section("child sessions")
if (sessions.data[0]) {
  const children = await client.session.list({ parentID: sessions.data[0].id, limit: 10 })
  console.log(`children of ${sessions.data[0].id}: ${children.data.length}`)
}

console.log("\nsmoke ok")

function status(file: EditedFile): string {
  return file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"
}
