import type { SessionMessageInfo } from "@opencode/client"
import { toRelative } from "./paths.ts"

export type EditStatus = "added" | "modified" | "deleted"

export interface EditedFile {
  /** Path relative to the project root. */
  path: string
  /** How many tool calls / snapshots touched this file in the session. */
  count: number
  /** Timestamp of the most recent touch. */
  last: number
  status: EditStatus
  /** Lines added across every tool touch (0 when unknown). */
  additions: number
  /** Lines removed across every tool touch (0 when unknown). */
  deletions: number
  /** Whether {@link additions}/{@link deletions} carry real numbers. */
  counted: boolean
}

/** Tool names that change file contents. Mirrors the built-in editing tools. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "multi_edit",
  "multi-edit",
  "apply_patch",
  "applypatch",
  "create_file",
  "str_replace_editor",
  "str_replace",
  "notebook_edit",
  "notebookedit",
  "insert_edit_into_file",
])

/** Editing tools that create/overwrite a whole file (as opposed to a diff). */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "write_file", "create_file", "createfile", "new_file"])

const PATH_KEYS = ["path", "filePath", "file_path", "filepath", "file", "filename"] as const
const OLD_KEYS = ["oldString", "old_string", "old_str", "old"] as const
const NEW_KEYS = ["newString", "new_string", "new_str", "new"] as const
const CONTENT_KEYS = ["content", "file_text", "newText"] as const
const PATCH_KEYS = ["patch", "diff"] as const

/** Loose view of a tool part's state, valid across streaming/running/done. */
interface ToolState {
  status: string
  input?: unknown
  content?: unknown
  metadata?: unknown
}

/** One entry of the `metadata.files` array emitted by the editing tools. */
interface MetaFile {
  file?: unknown
  status?: unknown
  additions?: unknown
  deletions?: unknown
}

interface Counts {
  status: EditStatus
  additions: number
  deletions: number
  counted: boolean
}

function mergeStatus(current: EditStatus, next: EditStatus): EditStatus {
  if (current === "added") return next === "deleted" ? "modified" : "added"
  if (next === "added") return current === "deleted" ? "modified" : "added"
  if (current === "deleted" || next === "deleted") return "deleted"
  return "modified"
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string") return value
  }
  return undefined
}

function pathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0
}

function normalizeStatus(value: unknown): EditStatus | undefined {
  return value === "added" || value === "modified" || value === "deleted" ? value : undefined
}

/** Count rendered lines, treating a single trailing newline as a terminator. */
function countLines(text: string): number {
  if (!text) return 0
  const lines = text.split("\n").length
  return text.endsWith("\n") ? lines - 1 : lines
}

/** Count `+`/`-` body lines in a unified diff, skipping file headers. */
function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions += 1
    else if (line.startsWith("-")) deletions += 1
  }
  return { additions, deletions }
}

function readMetadataFiles(state: ToolState): MetaFile[] | undefined {
  if (state.status !== "completed" && state.status !== "error") return undefined
  if (!state.metadata || typeof state.metadata !== "object") return undefined
  const files = (state.metadata as { files?: unknown }).files
  return Array.isArray(files) ? (files as MetaFile[]) : undefined
}

function resultText(state: ToolState): string | undefined {
  if (state.status !== "completed" && state.status !== "error") return undefined
  if (!Array.isArray(state.content)) return undefined
  for (const item of state.content) {
    if (item && typeof item === "object") {
      const entry = item as { type?: unknown; text?: unknown }
      if (entry.type === "text" && typeof entry.text === "string") return entry.text
    }
  }
  return undefined
}

/**
 * Best-effort line counts when `metadata.files` is unavailable (e.g. `write`,
 * whose result content has no diff). Writes report "Created" vs "Wrote" in the
 * result text, which tells additions-vs-modifications apart.
 */
function deriveCounts(toolName: string, input: unknown, text: string | undefined): Counts {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  let additions = 0
  let deletions = 0
  let counted = false

  const oldText = firstString(record, OLD_KEYS)
  const newText = firstString(record, NEW_KEYS)
  if (oldText !== undefined) {
    deletions += countLines(oldText)
    counted = true
  }
  if (newText !== undefined) {
    additions += countLines(newText)
    counted = true
  }

  if (!counted) {
    const content = firstString(record, CONTENT_KEYS)
    if (content !== undefined) {
      additions += countLines(content)
      counted = true
    }
  }

  const patch = firstString(record, PATCH_KEYS)
  if (patch !== undefined) {
    const counts = countPatch(patch)
    additions += counts.additions
    deletions += counts.deletions
    counted = true
  }

  const edits = record.edits
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue
      const entry = edit as Record<string, unknown>
      const oldEdit = firstString(entry, OLD_KEYS)
      const newEdit = firstString(entry, NEW_KEYS)
      if (oldEdit !== undefined) {
        deletions += countLines(oldEdit)
        counted = true
      }
      if (newEdit !== undefined) {
        additions += countLines(newEdit)
        counted = true
      }
    }
  }

  counted = counted && additions + deletions > 0

  let status: EditStatus = "modified"
  if (WRITE_TOOL_NAMES.has(toolName) && typeof text === "string") {
    status = /creat/i.test(text) ? "added" : "modified"
  }

  return { status, additions, deletions, counted }
}

/**
 * Derive the set of files a session touched, newest-first information kept per
 * file. Sources, in order of authority:
 *
 * 1. `metadata.files` on an editing tool part — the built-in `edit` tool emits
 *    `{ file, patch, status, additions, deletions }`, giving real diff stats.
 * 2. The tool input itself (old/new strings, content, patch, edits), with the
 *    result text distinguishing created from overwritten files.
 * 3. `snapshot.files` on each assistant message (authoritative for *which*
 *    files changed, but carries no counts).
 */
export function collectEdited(messages: readonly SessionMessageInfo[], root: string): Map<string, EditedFile> {
  const files = new Map<string, EditedFile>()

  const touch = (
    relative: string,
    status: EditStatus,
    at: number,
    additions: number,
    deletions: number,
    counted: boolean,
  ): void => {
    const existing = files.get(relative)
    if (!existing) {
      files.set(relative, { path: relative, count: 1, last: at, status, additions, deletions, counted })
      return
    }
    existing.count += 1
    if (at > existing.last) existing.last = at
    existing.status = mergeStatus(existing.status, status)
    existing.additions += additions
    existing.deletions += deletions
    existing.counted = existing.counted || counted
  }

  for (const message of messages) {
    if (message.type !== "assistant") continue
    const at = message.time.completed ?? message.time.created
    const seenThisMessage = new Set<string>()

    for (const part of message.content) {
      if (part.type !== "tool") continue
      if (!EDIT_TOOL_NAMES.has(part.name)) continue
      const state = part.state as unknown as ToolState
      if (state.status === "streaming") continue

      const metadataFiles = readMetadataFiles(state)
      if (metadataFiles && metadataFiles.length > 0) {
        let touched = false
        for (const entry of metadataFiles) {
          const relative = toRelative(root, String(entry.file ?? ""))
          if (!relative) continue
          touched = true
          seenThisMessage.add(relative)
          const additions = num(entry.additions)
          const deletions = num(entry.deletions)
          touch(
            relative,
            normalizeStatus(entry.status) ?? "modified",
            at,
            additions,
            deletions,
            additions + deletions > 0,
          )
        }
        if (touched) continue
      }

      const raw = pathFromInput(state.input)
      if (!raw) continue
      const relative = toRelative(root, raw)
      if (!relative) continue
      seenThisMessage.add(relative)
      const counts = deriveCounts(part.name, state.input, resultText(state))
      touch(relative, counts.status, at, counts.additions, counts.deletions, counts.counted)
    }

    // Catch-all: files the snapshot recorded but no tool input exposed.
    for (const file of message.snapshot?.files ?? []) {
      const relative = toRelative(root, file)
      if (relative && !seenThisMessage.has(relative)) touch(relative, "modified", at, 0, 0, false)
    }
  }

  return files
}
