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


async function scan($: any): Promise<Entry[]> {
  const out: Entry[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return
    let list: Array<{ name: string; kind: string }>
    try {
      list = await $.fs.list(dir || undefined)
    } catch {
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
  const [entries, found] = await Promise.all([scan($), gitChanges($)])
  await update($, tree, () => entries)
  await update($, changes, () => found)
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
        {rows.length === 0 && <Text dimColor>No files — run /tree again.</Text>}
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
          if (!change) return <Text key={entry.path}>{pad}  {entry.name}</Text>
          const stats = change.additions === undefined ? null : (
            <>
              <Text color="green"> +{change.additions}</Text>
              <Text color="red"> -{change.deletions}</Text>
            </>
          )
          return (
            <Text key={entry.path} color={color(change.status)}>
              {pad}{change.status} {entry.name}
              {stats}
            </Text>
          )
        })}
      </Box>
    )
  })
}
