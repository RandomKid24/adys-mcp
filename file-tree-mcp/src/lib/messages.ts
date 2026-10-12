import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client"

const PAGE_SIZE = 200
const MAX_PAGES = 20
const MAX_MESSAGES = 2000

/**
 * Fetch a session's message history, newest first, then return it in
 * chronological (oldest-first) order.
 *
 * The plugin data store (`ctx.data.session.message.list`) is windowed to a
 * handful of recent messages, so an edited-set built from it would forget the
 * top of long sessions. `message.list` paginates instead: the first page is
 * ordered newest-first and each `next` cursor walks further back. Fetching
 * newest-first means a cap keeps the most recent edits.
 */
export async function fetchSessionMessages(client: OpenCodeClient, sessionID: string): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = []
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = cursor
      ? await client.message.list({ sessionID, limit: PAGE_SIZE, cursor })
      : await client.message.list({ sessionID, limit: PAGE_SIZE, order: "desc" })
    messages.push(...response.data)

    const next = response.cursor.next ?? undefined
    if (!next || response.data.length === 0 || messages.length >= MAX_MESSAGES) break
    cursor = next
  }

  return messages.reverse()
}
