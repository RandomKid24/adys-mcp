import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, Entry } from '../types'

// Draws straight to the terminal: no model call, so it costs no tokens.
const PANE = 'file-tree'
const MAX_ENTRIES = 1500
const MAX_DEPTH = 5
const IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', '.DS_Store', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache',
  'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.idea', '.gradle', 'Pods', 'DerivedData',
])

const tree = atom({ plugin: 'file-tree-pane', key: 'tree' } as const, [])
const open = atom({ plugin: 'file-tree-pane', key: 'open' } as const, {})
const changes = atom({ plugin: 'file-tree-pane', key: 'changes' } as const, {})
const edit = atom({ plugin: 'file-tree-pane', key: 'edit' } as const, null)
const EDIT = 'file-edit'
const MAX_LINES = 5000
const note = atom({ plugin: 'file-tree-pane', key: 'note' } as const, '')


async function scan($: any, errors: string[]): Promise<Entry[]> {
  const out: Entry[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return
    let list: Array<{ name: string; kind: string }>
    try {
      list = await $.fs.list(dir || undefined)
    } catch (error) {
      errors.push(`${dir || '.'}: ${String(error)}`)
      return
    }
    list.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))
    for (const item of list) {
      if (IGNORE.has(item.name) || out.length >= MAX_ENTRIES) continue
      const path = dir ? `${dir}/${item.name}` : item.name
      const isDir = item.kind === 'dir'
      out.push({ path, name: item.name, depth, isDir })
      if (isDir) await walk(path, depth + 1)
    }
  }
  await walk('', 0)
  return out
}

async function gitChanges($: any): Promise<Record<string, Change>> {
  const git = (...args: string[]) => $.process.run(['git', '-c', 'core.quotepath=off', ...args])
  const result: Record<string, Change> = {}
  try {
    const status = await git('status', '--porcelain', '--untracked-files=all')
    if (status.exitCode !== 0) return result
    const prefix = (await git('rev-parse', '--show-prefix')).stdout.trim()
    const rel = (path: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path)
    for (const line of status.stdout.split('\n')) {
      if (line.length < 4) continue
      const code = line.slice(0, 2)
      const path = rel(line.slice(3).split(' -> ').pop()!)
      const kind = code.includes('D') ? 'D' : code.includes('A') || code === '??' || code.includes('R') ? 'A' : 'M'
      result[path] = { status: kind }
    }
    let numstat = await git('diff', 'HEAD', '--numstat')
    if (numstat.exitCode !== 0) numstat = await git('diff', '--numstat')
    for (const line of numstat.stdout.split('\n')) {
      const [add, del, path] = line.split('\t')
      const change = path && result[rel(path)]
      if (change && add !== '-') {
        change.additions = Number(add)
        change.deletions = Number(del)
      }
    }
  } catch {
    // no git: the tree still works, just without markers
  }
  return result
}

async function refresh($: any): Promise<void> {
  const errors: string[] = []
  let entries: Entry[] = []
  let found: Record<string, Change> = {}
  try {
    ;[entries, found] = await Promise.all([scan($, errors), gitChanges($)])
  } catch (error) {
    errors.push(String(error))
  }
  await update($, tree, () => entries)
  await update($, changes, () => found)
  await update($, note, () => (errors.length ? `scan error — ${errors[0]}` : `${entries.length} entries`))
}

// ---- line editor: the pane API has no multi-line field, so edit one line at a time ----

async function openFile($: any, path: string): Promise<void> {
  try {
    const text: string = await $.fs.read(path)
    const lines = text.split(/\r?\n/)
    if (text.includes('\0') || lines.length > MAX_LINES) {
      $.ui.toast(`${path}: binary or too large to edit here`)
      return
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    await update($, edit, () => ({ path, lines, eol, sel: -1, top: 0, msg: '' }))
    await $.ui.open({ id: EDIT, title: path })
  } catch (error) {
    $.ui.toast(`Could not open ${path}: ${String(error)}`)
  }
}

/** Write `lines` to the open file and record the outcome; `sel` is the new selection. */
async function commit($: any, lines: string[], sel: number): Promise<void> {
  const cur = await read($, edit)
  if (!cur) return
  let msg = 'saved'
  try {
    await $.fs.write(cur.path, lines.join(cur.eol))
  } catch (error) {
    msg = `save failed: ${String(error)}`
  }
  await update($, edit, prev => (prev ? { ...prev, lines, sel, msg } : prev))
  if (msg === 'saved') void refresh($).catch(() => {})
}

async function saveLine($: any, i: number, value: string): Promise<void> {
  const cur = await read($, edit)
  if (!cur) return
  const lines = cur.lines.slice()
  lines[i] = value
  await commit($, lines, -1)
}

async function insertBelow($: any, i: number): Promise<void> {
  const cur = await read($, edit)
  if (!cur) return
  const lines = cur.lines.slice()
  lines.splice(i + 1, 0, '')
  await commit($, lines, i + 1)
}

async function deleteLine($: any, i: number): Promise<void> {
  const cur = await read($, edit)
  if (!cur || cur.lines.length <= 1) return
  const lines = cur.lines.slice()
  lines.splice(i, 1)
  await commit($, lines, -1)
}

async function selectLine($: any, i: number): Promise<void> {
  await update($, edit, prev => (prev ? { ...prev, sel: i, msg: '' } : prev))
}

async function scrollBy($: any, delta: number, max: number): Promise<void> {
  await update($, edit, prev => (prev ? { ...prev, top: Math.max(0, Math.min(max, prev.top + delta)) } : prev))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tree', description: 'Show the project file tree with git changes (free, no tokens)' })
    return next(e)
  })

  on('command.run', { command: 'tree' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Files' })
    return { text: 'File tree opened.' }
  })

  // An edit landed: rescan so new files and git markers appear.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(e.tool)) void refresh($).catch(() => {})
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const entries = await read($, tree)
    const found = await read($, changes)
    const toggled = await read($, open)
    const info = await read($, note)

    // Folders holding changes open by default; the person's own toggles win.
    const withChanges = new Set<string>()
    for (const path of Object.keys(found)) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) withChanges.add(parts.slice(0, i).join('/'))
    }
    const isOpen = (path: string) => toggled[path] ?? withChanges.has(path)

    const rows: Entry[] = []
    let skip = Infinity
    for (const entry of entries) {
      if (entry.depth > skip) continue
      skip = Infinity
      rows.push(entry)
      if (entry.isDir && !isOpen(entry.path)) skip = entry.depth
    }

    const count = Object.keys(found).length
    const color = (s: Change['status']) => (s === 'A' ? 'green' : s === 'D' ? 'red' : 'yellow')

    return (
      <Box flexDirection="column">
        <Text bold>
          ◆ files{count > 0 ? <Text color="yellow"> ● {count}</Text> : null}
        </Text>
        {rows.length === 0 && <Text dimColor>No files ({info || 'not scanned yet'}) — run /tree again.</Text>}
        {rows.map(entry => {
          const pad = '  '.repeat(entry.depth)
          if (entry.isDir) {
            const dirOpen = isOpen(entry.path)
            return (
              <Button
                key={entry.path}
                plain
                onPress={() => void update($, open, all => ({ ...all, [entry.path]: !dirOpen }))}
              >
                <Text color="cyan">{pad}{dirOpen ? '▾' : '▸'} {entry.name}/</Text>
              </Button>
            )
          }
          const change = found[entry.path]
          if (!change) return (
            <Button key={entry.path} plain onPress={() => void openFile($, entry.path)}>
              <Text>{pad}  {entry.name}</Text>
            </Button>
          )
          const hasCounts = change.additions !== undefined
          return (
            <Button key={entry.path} plain onPress={() => void openFile($, entry.path)}>
              <Text color={color(change.status)}>
                {pad}{change.status} {entry.name}
                {hasCounts ? <Text color="green"> +{change.additions}</Text> : null}
                {hasCounts ? <Text color="red"> -{change.deletions}</Text> : null}
              </Text>
            </Button>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: EDIT }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const cur = await read($, edit)
    if (!cur) return <Text dimColor>Nothing open — click a file in /tree.</Text>

    const room = Math.max(5, (e.viewport?.rows ?? 24) - 6)
    const maxTop = Math.max(0, cur.lines.length - room)
    const top = Math.min(cur.top, maxTop)
    const width = String(cur.lines.length).length
    const visible = cur.lines.slice(top, top + room)

    return (
      <Box flexDirection="column">
        <Text bold>
          ✎ {cur.path}
          <Text color={cur.msg.startsWith('save failed') ? 'red' : 'green'}>{cur.msg ? `  ${cur.msg}` : ''}</Text>
        </Text>
        <Text dimColor>click a line, edit, Enter saves it to disk</Text>
        {visible.map((line, k) => {
          const i = top + k
          const label = String(i + 1).padStart(width, ' ')
          if (i === cur.sel) {
            return (
              <Input
                key={`line-${i}`}
                label={`${label} `}
                value={line}
                autoFocus
                submitLabel="save line"
                onSubmit={value => void saveLine($, i, value)}
              />
            )
          }
          return (
            <Button key={`row-${i}`} plain dimColor onPress={() => void selectLine($, i)}>
              <Text>{label} {line}</Text>
            </Button>
          )
        })}
        <Box flexDirection="row">
          <Button key="up" onPress={() => void scrollBy($, -room, maxTop)}>↑ page</Button>
          <Button key="down" onPress={() => void scrollBy($, room, maxTop)}>↓ page</Button>
          {cur.sel >= 0 ? <Button key="add" onPress={() => void insertBelow($, cur.sel)}>+ line below</Button> : null}
          {cur.sel >= 0 ? <Button key="del" onPress={() => void deleteLine($, cur.sel)}>× delete line</Button> : null}
          <Button key="close" role="dismiss" onPress={() => void $.ui.close({ id: EDIT })}>close</Button>
        </Box>
      </Box>
    )
  })
}
