export type Entry = { path: string; name: string; depth: number; isDir: boolean }
export type Edit = { path: string; lines: string[]; eol: string; sel: number; top: number; msg: string }
export type Change = { status: 'A' | 'M' | 'D'; additions?: number; deletions?: number }

declare module 'claude-code' {
  interface PluginState {
    'file-tree-pane': {
      tree: Entry[]
      open: Record<string, boolean>
      changes: Record<string, Change>
      note: string
      edit: Edit | null
    }
  }
}
