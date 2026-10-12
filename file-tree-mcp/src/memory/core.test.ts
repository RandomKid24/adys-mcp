// Run: node src/memory/core.test.ts
import assert from "node:assert/strict"
import { emptyGraph, forget, neighbors, recordSession, remember, search } from "./core.ts"

const g = emptyGraph()
const d = remember(g, { kind: "decision", title: "Use JWT cookies", why: "stateless", files: ["src/auth.ts"], at: 1 })
recordSession(g, "2026-01-01", ["src/auth.ts"], 2)
recordSession(g, "2026-01-01", ["src/db.ts"], 3) // same day merges into one node

assert.equal(g.nodes.filter((n) => n.kind === "session").length, 1)
assert.equal(search(g, "jwt", 5)[0]?.id, d.id)
assert.equal(neighbors(g, d.id).length, 1)
assert.equal(forget(g, d.id), true)
assert.equal(g.edges.some((e) => e.from === d.id || e.to === d.id), false)
console.log("core ok")
