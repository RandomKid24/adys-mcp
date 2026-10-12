import type { SessionMessageInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import type { Store } from "solid-js/store"
import type { ResolvedConfig, SettingsState, UiState } from "../lib/config.ts"
import { collectEdited, type EditStatus, type EditedFile } from "../lib/edited.ts"
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
  const edited = (): Map<string, EditedFile> => editedResource() ?? new Map<string, EditedFile>()

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

  /** Directories holding edits read brighter than empty ones. */
  const rowColor = (row: Row): RGBA => {
    if (row.edited) return statusColor(row.edited.status)
    if (row.kind === "dir") return dirTotals(row.path).files > 0 ? theme.text.base : theme.text.muted
    return theme.text.muted
  }

  const statSpans = (additions: number, deletions: number) => (
    <>
      <span style={{ fg: theme.diff.text.added }}>{` +${additions}`}</span>
      <span style={{ fg: theme.diff.text.removed }}>{` -${deletions}`}</span>
    </>
  )

  const fileStats = (file?: EditedFile) => {
    if (!file) return null
    if (file.counted) return statSpans(file.additions, file.deletions)
    return <span style={{ fg: statusColor(file.status) }}>{`  ${marker(file)}`}</span>
  }

  const dirStats = (path: string) => {
    const totals = dirTotals(path)
    if (!totals.counted || totals.additions + totals.deletions === 0) return null
    return statSpans(totals.additions, totals.deletions)
  }

  const toggle = (row: Row): void => {
    props.onToggleDir?.(row.path, !row.open)
  }

  const rows = () => (
    <For each={flat().rows}>
      {(row) => {
        const clickable = (): boolean => row.kind === "dir" && row.expandable === true
        return (
          <box
            flexDirection="row"
            backgroundColor={clickable() && hovered() === row.path ? theme.background.raised.base : undefined}
            onMouseUp={
              clickable()
                ? (event) => {
                    if (event.button === 0) toggle(row)
                  }
                : undefined
            }
            onMouseOver={clickable() ? () => setHovered(row.path) : undefined}
            onMouseOut={
              clickable() ? () => setHovered((current) => (current === row.path ? undefined : current)) : undefined
            }
          >
            <text wrapMode="none" fg={rowColor(row)}>
              <span style={{ fg: theme.text.muted }}>{row.guide}</span>
              <Show when={row.kind === "dir"}>
                <span style={{ fg: row.expandable ? theme.text.base : theme.text.muted }}>
                  {row.expandable ? (row.open ? "- " : "+ ") : "  "}
                </span>
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
        <span style={{ fg: theme.text.base }}>{rootName()}</span>
        <span style={{ fg: theme.text.muted }}>{`  ${edited().size} edited`}</span>
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
