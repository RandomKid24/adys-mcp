export type Entry = { path: string; name: string; depth: number; isDir: boolean }
export type Change = { status: 'A' | 'M' | 'D'; additions?: number; deletions?: number }

declare module 'claude-code' {
  interface PluginState {
    'file-tree-pane': {
      tree: Entry[]
      open: Record<string, boolean>
      changes: Record<string, Change>
    }
  }
}
