import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, Entry, Hit } from '../types'

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
const view = atom({ plugin: 'file-tree-pane', key: 'view' } as const, null)
const find = atom({ plugin: 'file-tree-pane', key: 'find' } as const, null)
const active = atom({ plugin: 'file-tree-pane', key: 'active' } as const, '')
const dots = atom({ plugin: 'file-tree-pane', key: 'dots' } as const, false)
const creating = atom({ plugin: 'file-tree-pane', key: 'creating' } as const, false)
const VIEW = 'file-view'
const FIND = 'file-find'
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

async function openEditor($: any, path: string, line = 0): Promise<void> {
  try {
    const text: string = await $.fs.read(path)
    const lines = text.split(/\r?\n/)
    if (text.includes('\0') || lines.length > MAX_LINES) {
      $.ui.toast(`${path}: binary or too large to edit here`)
      return
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    await update($, edit, () => ({ path, lines, eol, sel: line > 0 ? line - 1 : -1, top: Math.max(0, line - 3), msg: '' }))
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


// ---- viewer (syntax highlighting, diff), search, file operations ----

async function run($: any, argv: string[]): Promise<{ exitCode: number; stdout: string }> {
  try {
    const r = await $.process.run(argv)
    return { exitCode: r.exitCode, stdout: r.stdout }
  } catch {
    return { exitCode: -1, stdout: '' } // could not start
  }
}

async function openView($: any, path: string): Promise<void> {
  const text: string = await $.fs.read(path).catch(() => '')
  const change = (await read($, changes))[path]
  if (text.includes('\0')) return void $.ui.toast(`${path}: binary file`)
  if (!text && !change) return void $.ui.toast(`${path}: not found`)
  let diff = ''
  if (change) {
    let r = await run($, ['git', 'diff', 'HEAD', '--', path])
    if (!r.stdout) r = await run($, ['git', 'diff', '--', path])
    if (!r.stdout && change.status === 'A') r = await run($, ['git', 'diff', '--no-index', '--', '/dev/null', path])
    diff = r.stdout
  }
  await update($, view, () => ({ path, lines: text.split(/\r?\n/), top: 0, mode: 'file', diff, confirm: '', renaming: false, msg: '' }))
  await $.ui.open({ id: VIEW, title: path })
}

async function patchView($: any, fields: Record<string, unknown>): Promise<void> {
  await update($, view, prev => (prev ? { ...prev, ...fields } : prev))
}

async function viewScroll($: any, delta: number, max: number): Promise<void> {
  await update($, view, prev => (prev ? { ...prev, top: Math.max(0, Math.min(max, prev.top + delta)) } : prev))
}

async function deleteFile($: any): Promise<void> {
  const cur = await read($, view)
  if (!cur) return
  const r = await run($, ['rm', '--', cur.path])
  if (r.exitCode !== 0) return patchView($, { confirm: '', msg: 'delete failed' })
  await update($, view, () => null)
  await $.ui.close({ id: VIEW })
  void refresh($).catch(() => {})
}

async function revertFile($: any): Promise<void> {
  const cur = await read($, view)
  if (!cur) return
  const r = await run($, ['git', 'checkout', 'HEAD', '--', cur.path])
  void refresh($).catch(() => {})
  if (r.exitCode !== 0) return patchView($, { confirm: '', msg: 'revert failed' })
  await openView($, cur.path)
  await patchView($, { msg: 'reverted to HEAD' })
}

async function renameFile($: any, to: string): Promise<void> {
  const cur = await read($, view)
  const target = to.trim()
  if (!cur || !target || target === cur.path || target.startsWith('/') || target.includes('..')) {
    return patchView($, { renaming: false })
  }
  const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : ''
  if (dir) await run($, ['mkdir', '-p', '--', dir])
  const r = await run($, ['mv', '--', cur.path, target])
  if (r.exitCode !== 0) return patchView($, { renaming: false, msg: 'rename failed' })
  await refresh($)
  await openView($, target)
}

async function createFile($: any, path: string): Promise<void> {
  const target = path.trim()
  await update($, creating, () => false)
  if (!target || target.startsWith('/') || target.includes('..')) return
  // never truncate an existing file
  if (!(await $.fs.exists(target))) await $.fs.write(target, '')
  await refresh($)
  await openEditor($, target)
}

async function openExternal($: any, path: string, line: number): Promise<void> {
  for (const argv of [['code', '-g', `${path}:${line}`], ['open', path], ['xdg-open', path]]) {
    if ((await run($, argv)).exitCode === 0) return void $.ui.toast(`Opened ${path}`)
  }
  $.ui.toast('No editor found (tried code, open, xdg-open)')
}

/** Costs tokens: it sends a prompt, so it is an explicit button. */
async function askClaude($: any, path: string): Promise<void> {
  await $.prompt.submit({ text: `Read ${path} and wait for my instructions.`, asUser: true })
}

async function search($: any, query: string): Promise<number> {
  const q = query.trim()
  if (!q) return 0
  let r = await run($, ['git', 'grep', '-n', '-I', '-F', '--max-count=3', '-e', q])
  if (r.exitCode > 1 || r.exitCode < 0) {
    r = await run($, ['grep', '-rnIF', '--exclude-dir=node_modules', '--exclude-dir=.git', '-m', '3', '--', q, '.'])
  }
  const hits: Hit[] = []
  for (const line of r.stdout.split('\n')) {
    const m = /^(.*?):(\d+):(.*)$/.exec(line)
    if (!m) continue
    hits.push({ path: m[1].replace(/^\.\//, ''), line: Number(m[2]), text: m[3].trim().slice(0, 160) })
    if (hits.length >= 200) break
  }
  await update($, find, () => ({ query: q, hits }))
  await $.ui.open({ id: FIND, title: `find: ${q}` })
  return hits.length
}

/** Mark the file the agent just touched and open its folders. */
async function markActive($: any, absolute: string): Promise<void> {
  const entries = await read($, tree)
  let best = ''
  for (const entry of entries) {
    if (!entry.isDir && (absolute === entry.path || absolute.endsWith(`/${entry.path}`)) && entry.path.length > best.length) {
      best = entry.path
    }
  }
  if (!best) return
  await update($, active, () => best)
  const parts = best.split('/')
  await update($, open, all => {
    const next = { ...all }
    for (let i = 1; i < parts.length; i++) next[parts.slice(0, i).join('/')] = true
    return next
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tree', description: 'Show the project file tree with git changes (free, no tokens)' })
    await $.command.register({ name: 'find', description: 'Search file contents and open a match (free, no tokens)', argumentHint: '<text>' })
    return next(e)
  })

  on('command.run', { command: 'tree' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Files' })
    return { text: 'File tree opened.' }
  })

  on('command.run', { command: 'find' }, async ($, e) => {
    const count = await search($, e.args)
    return { text: `${count} match${count === 1 ? '' : 'es'}.` }
  })

  // An edit landed: rescan, and follow the agent to the file it touched.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(e.tool)) {
      const target = String((e as any).file_path ?? (e as any).notebook_path ?? '')
      void refresh($).then(() => (target ? markActive($, target) : undefined)).catch(() => {})
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    await update($, active, () => '')
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const entries = await read($, tree)
    const found = await read($, changes)
    const toggled = await read($, open)
    const info = await read($, note)
    const current = await read($, active)
    const showDots = await read($, dots)
    const isCreating = await read($, creating)

    // Folders holding changes open by default; the person's own toggles win.
    const withChanges = new Set<string>()
    for (const path of Object.keys(found)) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) withChanges.add(parts.slice(0, i).join('/'))
    }
    const isOpen = (path: string) => toggled[path] ?? withChanges.has(path)
    const isHidden = (path: string) => !showDots && path.split('/').some(part => part.startsWith('.'))

    const rows: Entry[] = []
    let skip = Infinity
    for (const entry of entries) {
      if (entry.depth > skip) continue
      skip = Infinity
      if (isHidden(entry.path)) continue
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
        <Box flexDirection="row">
          <Button key="new" onPress={() => void update($, creating, was => !was)}>+ file</Button>
          <Button key="dots" onPress={() => void update($, dots, was => !was)}>{showDots ? 'hide dotfiles' : 'show dotfiles'}</Button>
          <Button key="refresh" onPress={() => void refresh($)}>↻</Button>
        </Box>
        {isCreating ? (
          <Input key="create" label="new file " placeholder="src/example.ts" autoFocus submitLabel="create" onSubmit={value => void createFile($, value)} />
        ) : null}
        <Input key="find" label="find " placeholder="search in files" submitLabel="search" onSubmit={value => void search($, value)} />
        {rows.length === 0 && <Text dimColor>No files ({info || 'not scanned yet'}) — run /tree again.</Text>}
        {rows.map(entry => {
          const pad = '  '.repeat(entry.depth)
          if (entry.isDir) {
            const dirOpen = isOpen(entry.path)
            return (
              <Button key={entry.path} plain onPress={() => void update($, open, all => ({ ...all, [entry.path]: !dirOpen }))}>
                <Text color="cyan">{pad}{dirOpen ? '▾' : '▸'} {entry.name}/</Text>
              </Button>
            )
          }
          const change = found[entry.path]
          const isActive = entry.path === current
          const hasCounts = change !== undefined && change.additions !== undefined
          return (
            <Button key={entry.path} plain onPress={() => void openView($, entry.path)}>
              <Text color={change ? color(change.status) : undefined} bold={isActive}>
                {pad}{change ? `${change.status} ` : '  '}{entry.name}
                {hasCounts ? <Text color="green"> +{change.additions}</Text> : null}
                {hasCounts ? <Text color="red"> -{change.deletions}</Text> : null}
                {isActive ? <Text color="magenta"> ◀ editing</Text> : null}
              </Text>
            </Button>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: VIEW }, async ($, e) => {
    const { Box, Text, Button, Input, Code } = $.ui.resolve(e)
    const cur = await read($, view)
    const found = await read($, changes)
    if (!cur) return <Text dimColor>Nothing open — click a file in /tree.</Text>

    const room = Math.max(5, (e.viewport?.rows ?? 24) - 8)
    const maxTop = Math.max(0, cur.lines.length - room)
    const top = Math.min(cur.top, maxTop)
    const body = cur.lines.slice(top, top + room).join('\n')
    const change = found[cur.path]
    const hasDiff = cur.diff.length > 0

    return (
      <Box flexDirection="column">
        <Text bold>
          {cur.mode === 'diff' ? '± ' : '▤ '}{cur.path}
          <Text color={cur.msg.includes('failed') ? 'red' : 'green'}>{cur.msg ? `  ${cur.msg}` : ''}</Text>
        </Text>
        <Box flexDirection="row">
          <Button key="edit" variant="primary" onPress={() => void openEditor($, cur.path, top + 1)}>edit</Button>
          {hasDiff ? (
            <Button key="mode" onPress={() => void patchView($, { mode: cur.mode === 'diff' ? 'file' : 'diff' })}>
              {cur.mode === 'diff' ? 'file' : 'diff'}
            </Button>
          ) : null}
          <Button key="ext" onPress={() => void openExternal($, cur.path, top + 1)}>open in editor</Button>
          <Button key="ask" onPress={() => void askClaude($, cur.path)}>→ Claude (tokens)</Button>
          <Button key="ren" onPress={() => void patchView($, { renaming: !cur.renaming })}>rename</Button>
          {change && change.status !== 'A' && hasDiff ? <Button key="rev" onPress={() => void patchView($, { confirm: 'revert' })}>revert</Button> : null}
          <Button key="del" onPress={() => void patchView($, { confirm: 'delete' })}>delete</Button>
          <Button key="close" role="dismiss" onPress={() => void $.ui.close({ id: VIEW })}>close</Button>
        </Box>
        {cur.confirm ? (
          <Box flexDirection="row">
            <Text color="red">{cur.confirm === 'delete' ? `Delete ${cur.path}? ` : `Discard all changes to ${cur.path}? `}</Text>
            <Button key="yes" onPress={() => void (cur.confirm === 'delete' ? deleteFile($) : revertFile($))}>yes</Button>
            <Button key="no" onPress={() => void patchView($, { confirm: '' })}>no</Button>
          </Box>
        ) : null}
        {cur.renaming ? (
          <Input key="rename" label="rename to " value={cur.path} autoFocus submitLabel="rename" onSubmit={value => void renameFile($, value)} />
        ) : null}
        {cur.mode === 'diff' ? (
          <Code source={cur.diff} format="diff" />
        ) : body.length === 0 ? (
          <Text dimColor>(empty file)</Text>
        ) : (
          <Code source={body} path={cur.path} startLine={top + 1} />
        )}
        {cur.mode === 'file' && maxTop > 0 ? (
          <Box flexDirection="row">
            <Button key="up" onPress={() => void viewScroll($, -room, maxTop)}>↑ page</Button>
            <Button key="down" onPress={() => void viewScroll($, room, maxTop)}>↓ page</Button>
            <Text dimColor> {top + 1}–{Math.min(cur.lines.length, top + room)} of {cur.lines.length}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: FIND }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const result = await read($, find)
    if (!result) return <Text dimColor>Run /find &lt;text&gt;.</Text>
    return (
      <Box flexDirection="column">
        <Text bold>⌕ {result.query}  <Text dimColor>{result.hits.length} match{result.hits.length === 1 ? '' : 'es'}</Text></Text>
        {result.hits.length === 0 ? <Text dimColor>No matches.</Text> : null}
        {result.hits.map((hit, i) => (
          <Button key={`hit-${i}`} plain onPress={() => void openEditor($, hit.path, hit.line)}>
            <Text><Text color="cyan">{hit.path}:{hit.line}</Text>  {hit.text}</Text>
          </Button>
        ))}
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
