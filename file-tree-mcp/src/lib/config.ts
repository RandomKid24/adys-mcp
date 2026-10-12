import { createIgnore } from "./ignore.ts"

/** Ephemeral UI state, shared between the sidebar component and the commands. */
export interface UiState {
  visible: boolean
  onlyEdited: boolean
  /** Bumped to force a tree rescan. */
  refresh: number
  /** Bumped when edits land, to recompute the highlighted set. */
  editTick: number
  /** Explicit expand/collapse overrides for directories, keyed by path. */
  expanded: Record<string, boolean>
  /** Transient override forcing every folder open (`true`) or closed (`false`). */
  expandAll?: boolean
  /** Paths deleted during the session, kept visible as ghost rows. */
  removed: string[]
}

/** Persisted view settings. */
export interface SettingsState {
  maxDepth: number
  maxRows: number
  expandDepth: number
}

export interface ResolvedConfig {
  /** Whether the sidebar tree is rendered at all. */
  visible: boolean
  /** Start in "only edited files" mode instead of the full tree. */
  onlyEdited: boolean
  /** Include files edited by child (subagent) sessions of the current session. */
  includeSubagents: boolean
  /** How many directory levels to walk below the project root. */
  maxDepth: number
  /** Upper bound on rendered rows, to keep the sidebar bounded. */
  maxRows: number
  /** Rows shown in the sidebar before collapsing into "+N more". */
  sidebarRows: number
  /** Directories at depth below this are expanded by default. */
  expandDepth: number
  /** Concurrent `file.list` requests while walking. */
  concurrency: number
  /** Extra path segments to ignore, on top of {@link DEFAULT_IGNORES}. */
  ignore: ReadonlySet<string>
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean)
  return []
}

/** Normalize the plugin options supplied through `opencode.json(c)`. */
export function resolveConfig(options: Readonly<Record<string, unknown>>): ResolvedConfig {
  return {
    visible: bool(options.visible, true),
    onlyEdited: bool(options.onlyEdited, false),
    includeSubagents: bool(options.includeSubagents, false),
    maxDepth: clampInt(options.maxDepth, 4, 1, 12),
    maxRows: clampInt(options.maxRows, 160, 10, 2000),
    sidebarRows: clampInt(options.sidebarRows, 15, 3, 200),
    expandDepth: clampInt(options.expandDepth, 1, 1, 12),
    concurrency: clampInt(options.concurrency, 8, 1, 32),
    ignore: createIgnore(stringList(options.ignore)),
  }
}
