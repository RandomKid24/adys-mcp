import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { collectEdited } from "../lib/edited.ts"
import { fetchSessionMessages } from "../lib/messages.ts"
import { parseGraph, recordSession } from "./core.ts"

const GRAPH = ".memory/graph.json"

/**
 * Record the files a finished OpenCode run edited into today's session node of
 * the project-memory graph. Best effort: memory capture must never break a session.
 */
export async function captureSession(client: OpenCodeClient, location: LocationRef, directory: string, sessionID: string): Promise<void> {
  try {
    const edited = collectEdited(await fetchSessionMessages(client, sessionID), directory)
    const files = [...edited.keys()]
    if (files.length === 0) return

    const existing = await client.file.read({ location, path: GRAPH }).then(
      (bytes) => new TextDecoder().decode(bytes),
      () => undefined, // no graph yet
    )
    const graph = parseGraph(existing)
    const now = Date.now()
    recordSession(graph, new Date(now).toISOString().slice(0, 10), files, now)
    await client.file.write({ location, path: GRAPH, payload: new TextEncoder().encode(JSON.stringify(graph, null, 2) + "\n") })
  } catch {
    // ignore
  }
}
