import type { SessionMessageInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import type { Store } from "solid-js/store"
import type { ResolvedConfig, SettingsState, UiState } from "../lib/config.ts"
import { collectEdited, type EditStatus, type EditedFile } from "../lib/edited.ts"
import { openEditor } from "./Editor.tsx"
import { fetchSessionMessages } from "../lib/messages.ts"
import { baseName } from "../lib/paths.ts"
import { flattenEdited, flattenTree, marker, type Row } from "../lib/render.ts"
import { mergeDeletedFiles, scanTree } from "../lib/scan.ts"

export interface FileTreeProps {
  sessionID: string
  config: ResolvedConfig
  ui: Store<UiState>
  settings: Store<SettingsState>
  /** Panel focus state, forwarded to the scrollbox so keys scroll the tree. */
  focused?: boolean
  /** Toggle a directory's expanded state (persisted in the shared UI store). */
  onToggleDir?: (path: string, open: boolean) => void
  /** Called after a file is saved from the editor, to refresh highlights. */
  onSaved?: () => void
}

export function FileTree(props: FileTreeProps) {
  const ctx = usePlugin()
  const theme = ctx.theme

  const location = () => ctx.location ?? ctx.data.location.default()
  const rootName = () => baseName(location().directory) || location().directory

  const sessionIDs = createMemo(() => {
    const ids = new Set<string>([props.sessionID])
    if (props.config.includeSubagents) {
      for (const id of ctx.data.session.family(props.sessionID)) ids.add(id)
    }
    return [...ids]
  })

  // Fetch the session's full message history directly (the live store only
  // keeps a small recent window), refreshing shortly after each edit lands.
  const [editTick, setEditTick] = createSignal(props.ui.editTick)
  let debounce: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const tick = props.ui.editTick
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => setEditTick(tick), 200)
  })
  onCleanup(() => {
    if (debounce) clearTimeout(debounce)
  })

  const [editedResource] = createResource(
    () => ({ ids: sessionIDs(), root: location().directory, tick: editTick(), removed: [...props.ui.removed] }),
    async (source) => {
      const messages: SessionMessageInfo[] = []
      for (const id of source.ids) {
        try {
          messages.push(...(await fetchSessionMessages(ctx.client, id)))
        } catch {
          // A failed fetch should never blank the tree.
        }
      }
      const map = collectEdited(messages, source.root)
      // Files the watcher saw removed stay visible as red ghost rows, even if
      // they had been edited earlier in the session.
      for (const path of source.removed) {
        const existing = map.get(path)
        if (existing) existing.status = "deleted"
        else map.set(path, { path, count: 1, last: 0, status: "deleted", additions: 0, deletions: 0, counted: false })
      }
      return map
    },
    { initialValue: new Map<string, EditedFile>() },
  )

  // Working-tree changes from git, so files edited outside the agent show up too.
  const [git] = createResource(
    () => ({ location: location(), tick: editTick(), refresh: props.ui.refresh }),
    async (source) => {
      if (!props.config.gitStatus) return []
      try {
        return (await ctx.client.vcs.status({ location: source.location })).data
      } catch {
        return [] // not a git repo / vcs unavailable
      }
    },
    { initialValue: [] },
  )

  const edited = createMemo((): Map<string, EditedFile> => {
    const map = new Map(editedResource() ?? [])
    for (const change of git() ?? []) {
      if (map.has(change.file)) continue
      map.set(change.file, {
        path: change.file,
        count: 1,
        last: 0,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        counted: true,
      })
    }
    return map
  })

  const [tree] = createResource(
    () => ({
      location: location(),
      maxDepth: props.settings.maxDepth,
      maxRows: props.settings.maxRows,
      refresh: props.ui.refresh,
    }),
    (source) =>
      scanTree(ctx.client, source.location, {
        maxDepth: source.maxDepth,
        maxRows: source.maxRows,
        concurrency: props.config.concurrency,
        ignore: props.config.ignore,
      }),
  )

  /** Explicit user overrides win; otherwise expand by depth. */
  const isOpen = (path: string, depth: number): boolean => {
    const override = props.ui.expanded[path]
    if (override !== undefined) return override
    if (props.ui.expandAll !== undefined) return props.ui.expandAll
    return depth < props.settings.expandDepth
  }

  const [hovered, setHovered] = createSignal<string | undefined>(undefined)

  const flat = createMemo(() => {
    const editedMap = edited()
    if (props.ui.onlyEdited) return flattenEdited(editedMap, props.settings.maxRows)
    const deleted: string[] = []
    for (const file of editedMap.values()) if (file.status === "deleted") deleted.push(file.path)
    const nodes = mergeDeletedFiles(tree()?.nodes ?? [], deleted)
    return flattenTree(nodes, editedMap, isOpen, props.settings.maxRows)
  })

  const statusColor = (status: EditStatus): RGBA =>
    status === "added"
      ? theme.diff.text.added
      : status === "deleted"
        ? theme.diff.text.removed
        : theme.text.feedback.warning.base

  const displayName = (row: Row): string => (row.kind === "dir" ? `${row.name}/` : row.name)

  const dirTotals = (path: string): { additions: number; deletions: number; counted: boolean; files: number } => {
    let additions = 0
    let deletions = 0
    let counted = false
    let files = 0
    for (const file of edited().values()) {
      if (file.path === path || file.path.startsWith(`${path}/`)) {
        additions += file.additions
        deletions += file.deletions
        counted = counted || file.counted
        files += 1
      }
    }
    return { additions, deletions, counted, files }
  }

  const EXT_TOKENS: Record<string, keyof typeof theme.syntax> = {
    ts: "type", tsx: "type", js: "function", jsx: "function", mjs: "function", py: "string", go: "type", rs: "keyword",
    json: "number", yaml: "number", yml: "number", toml: "number", md: "comment", txt: "comment", css: "keyword",
    scss: "keyword", html: "keyword", sh: "operator", sql: "variable",
  }
  /** Source files pick up a syntax hue by extension; anything unknown stays plain text. */
  const extColor = (name: string): RGBA => {
    const token = EXT_TOKENS[name.slice(name.lastIndexOf(".") + 1).toLowerCase()]
    return token ? theme.syntax[token] : theme.text.base
  }

  /** Folders in the accent hue (brighter when they hold edits), files in base text, edits by status. */
  const rowColor = (row: Row): RGBA => {
    if (row.edited) return statusColor(row.edited.status)
    if (row.kind === "dir") return dirTotals(row.path).files > 0 ? theme.hue.accent[400] : theme.hue.accent[600]
    return extColor(row.name)
  }

  const statSpans = (additions: number, deletions: number) => (
    <>
      <span style={{ fg: theme.diff.text.added }}>{` +${additions}`}</span>
      <span style={{ fg: theme.diff.text.removed }}>{` -${deletions}`}</span>
    </>
  )

  const fileStats = (file?: EditedFile) => {
    if (!file) return null
    return file.counted ? statSpans(file.additions, file.deletions) : null
  }

  const dirStats = (path: string) => {
    const totals = dirTotals(path)
    if (!totals.counted || totals.additions + totals.deletions === 0) return null
    return statSpans(totals.additions, totals.deletions)
  }

  const toggle = (row: Row): void => {
    props.onToggleDir?.(row.path, !row.open)
  }

  const openFile = (row: Row): void => openEditor(ctx, row.path, location(), () => props.onSaved?.())

  const rows = () => (
    <For each={flat().rows}>
      {(row) => {
        const clickable = (): boolean => row.kind === "file" || row.expandable === true
        return (
          <box
            flexDirection="row"
            backgroundColor={clickable() && hovered() === row.path ? theme.background.raised.high : undefined}
            onMouseUp={
              clickable()
                ? (event) => {
                    if (event.button === 0) (row.kind === "dir" ? toggle(row) : openFile(row))
                  }
                : undefined
            }
            onMouseOver={clickable() ? () => setHovered(row.path) : undefined}
            onMouseOut={
              clickable() ? () => setHovered((current) => (current === row.path ? undefined : current)) : undefined
            }
          >
            <text wrapMode="none" fg={rowColor(row)}>
              <span style={{ fg: theme.border.base }}>{row.guide}</span>
              <Show when={row.kind === "dir"}>
                <span style={{ fg: theme.hue.accent[500] }}>{row.expandable ? (row.open ? "▾ " : "▸ ") : "  "}</span>
              </Show>
              <Show when={row.kind === "file" && row.edited}>
                <span style={{ fg: rowColor(row) }}>{`${marker(row.edited!)} `}</span>
              </Show>
              <span style={{ fg: rowColor(row) }}>{displayName(row)}</span>
              {row.kind === "dir" ? dirStats(row.path) : fileStats(row.edited)}
            </text>
          </box>
        )
      }}
    </For>
  )

  const empty = () =>
    props.ui.onlyEdited ? "No files edited yet" : "No files"

  return (
    <box flexDirection="column">
      <text wrapMode="none" fg={theme.text.base}>
        <span style={{ fg: theme.hue.accent[500] }}>{"◆ "}</span>
        <span style={{ fg: theme.text.base }}>{rootName()}</span>
        <Show when={edited().size > 0}>
          <span style={{ fg: theme.text.feedback.warning.base }}>{`  ● ${edited().size}`}</span>
        </Show>
      </text>

      <Show when={flat().rows.length > 0} fallback={<text wrapMode="none" fg={theme.text.muted}>{empty()}</text>}>
        <scrollbox height={Math.min(flat().rows.length, props.config.sidebarRows)} scrollY focused={props.focused}>
          {rows()}
        </scrollbox>
      </Show>

      <Show when={flat().truncated}>
        <text wrapMode="none" fg={theme.text.muted}>… truncated (raise maxRows / maxDepth)</text>
      </Show>
    </box>
  )
}
