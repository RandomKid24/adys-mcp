import type { SessionMessageInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin"
import type { JsonSchema } from "effect"
import { collectEdited, type EditedFile } from "./src/lib/edited.ts"

const EDITED_FILES_INPUT: JsonSchema.JsonSchema = {
  type: "object",
  properties: {
    sessionID: {
      type: "string",
      description: "Session to inspect. Defaults to the session that called the tool.",
    },
    includeSubagents: {
      type: "boolean",
      description: "Also include files edited by child (subagent) sessions.",
    },
  },
  required: [],
  additionalProperties: false,
}

const STATUS_LABEL: Record<EditedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
}

function format(files: readonly EditedFile[]): string {
  if (files.length === 0) return "No files were edited in this session."
  const lines = files.map((file) => {
    const stats = file.counted ? `  +${file.additions} -${file.deletions}` : ""
    const touches = file.count > 1 ? `  (×${file.count})` : ""
    return `${STATUS_LABEL[file.status]}  ${file.path}${stats}${touches}`
  })
  return `${files.length} file(s) edited in this session:\n${lines.join("\n")}`
}

/**
 * The child-session walk needs `session.list`, which the plugin's typed `session`
 * pick does not expose even though the runtime client provides it. We model just
 * the shape we use and degrade gracefully when it is unavailable.
 */
interface SessionLister {
  list?: (input?: { parentID?: string | null; limit?: number }) => Promise<{
    data?: ReadonlyArray<{ id: string; parentID?: string }>
  }>
}

async function sessionIDsWithChildren(
  session: unknown,
  root: string,
  includeSubagents: boolean,
): Promise<string[]> {
  const ids = new Set<string>([root])
  if (!includeSubagents) return [...ids]

  const lister = session as SessionLister
  if (typeof lister.list !== "function") return [...ids]

  let frontier: string[] = [root]
  while (frontier.length > 0) {
    const pages = await Promise.all(
      frontier.map(async (parent) => {
        try {
          const page = await lister.list!({ parentID: parent, limit: 100 })
          return page.data ?? []
        } catch {
          return []
        }
      }),
    )
    const next: string[] = []
    for (const child of pages.flat()) {
      if (!child?.id || ids.has(child.id)) continue
      ids.add(child.id)
      next.push(child.id)
    }
    frontier = next
  }
  return [...ids]
}

/**
 * Server-side half of the plugin. It exposes the same "which files is this
 * session editing" data the sidebar highlights, so the agent (or another client)
 * can query it directly.
 */
export default Plugin.define({
  id: "opencode-file-tree.server",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "filetree",
        description: "Inspect the files a session has edited.",
      })

      editor.add({
        name: "edited_files",
        description:
          "List the files edited in a session, newest first, with an add/modify/delete status, line changes and how many times each was touched.",
        input: EDITED_FILES_INPUT,
        options: { namespace: "filetree" },
        execute: async (input, context) => {
          const record = (input ?? {}) as { sessionID?: string; includeSubagents?: boolean }
          const sessionID = record.sessionID ?? context.sessionID

          const sessionIDs = await sessionIDsWithChildren(ctx.session, sessionID, record.includeSubagents ?? false)

          const messages: SessionMessageInfo[] = []
          for (const id of sessionIDs) {
            const found = await ctx.session.context({ sessionID: id })
            messages.push(...found)
          }

          const edited = collectEdited(messages, ctx.location.directory)
          const files = [...edited.values()].sort(
            (left, right) => right.last - left.last || left.path.localeCompare(right.path),
          )

          return {
            content: format(files),
            metadata: {
              sessionID,
              sessions: sessionIDs.length,
              count: files.length,
              files: files.map((file) => ({
                path: file.path,
                status: file.status,
                count: file.count,
                additions: file.additions,
                deletions: file.deletions,
              })),
            },
          }
        },
      })
    })
  },
})
