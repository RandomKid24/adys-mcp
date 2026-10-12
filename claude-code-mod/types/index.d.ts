export type Entry = { path: string; name: string; depth: number; isDir: boolean }
export type Change = { status: 'A' | 'M' | 'D'; additions?: number; deletions?: number }
export type Edit = { path: string; lines: string[]; eol: string; sel: number; top: number; msg: string }
export type View = {
  path: string
  lines: string[]
  top: number
  mode: 'file' | 'diff'
  diff: string
  confirm: '' | 'delete' | 'revert'
  renaming: boolean
  msg: string
}
export type Hit = { path: string; line: number; text: string }
export type Find = { query: string; hits: Hit[] }

declare module 'claude-code' {
  interface PluginState {
    'file-tree-pane': {
      tree: Entry[]
      open: Record<string, boolean>
      changes: Record<string, Change>
      note: string
      edit: Edit | null
      view: View | null
      find: Find | null
      active: string
      dots: boolean
      creating: boolean
    }
  }
}
