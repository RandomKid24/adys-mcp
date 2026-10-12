# file-tree-mcp

Two things in one package:

1. **Universal MCP server** (`mcp.ts`) — works in any MCP client. Tools: `file_tree` (project tree, changed files tagged `[A]/[M]/[D]` with `+N -M`) and `edited_files` (uncommitted changes, from git).
2. **OpenCode plugin** (below) — the live sidebar tree.

## Universal MCP setup

Needs Node >= 18 and `git`. One command for every client found on your machine: `npx -y github:RandomKid24/adys-mcp install` (backs up each config to `.bak`; safe to re-run). The server ships prebuilt as `mcp.js`; rebuild with `npx esbuild` via `npm run build` after editing `mcp.ts`.

Manual config: Project root = the client's cwd, or pass it as the first argument.

```jsonc
// Claude Code / Cursor / Claude Desktop (mcpServers)
{ "file-tree": { "command": "node", "args": ["/absolute/path/to/file-tree-mcp/mcp.ts"] } }
```

Claude Code: `claude mcp add file-tree -- node /absolute/path/to/file-tree-mcp/mcp.ts`

Not available over MCP: the sidebar (MCP has no UI), and per-session attribution (git shows all uncommitted changes, not just the agent's).

---

# opencode-file-tree

A project file tree in the OpenCode sidebar that **highlights the files the agent is editing right now**, plus a `filetree_edited_files` tool so the agent — or another client — can ask what a session changed.

Built for OpenCode v2.

```
my-project
  ├─ + src/                     +163 -12
  │  ├─ + components/
  │  │  └─ FileTree.tsx         +517 -73
  │  └─ - lib/
  │     ├─ render.ts            +169 -0
  │     └─ messages.ts          +31 -0
  └─ - README.md                +202 -0
```

- **Added** shows green, **modified** yellow, **deleted** red; files carry their
  line deltas (`+N` green / `-M` red), and directories show the totals beneath
  them.
- Click a folder row to expand or collapse it. Folders show a `+` / `-` icon;
  the hovered row is highlighted.
- A trailing count appears when a file was touched more than once.

## Features

- Sidebar tree for the active project, driven by the `sidebar.content` slot.
- Live highlighting from the session's tool calls and message snapshots.
- **Clickable folders** with `+` / `-` expand-collapse icons and a hover
  highlight.
- **Per-file line stats** (`+N` green / `-M` red) parsed from the editing tools'
  metadata, with directory totals rolled up from their contents.
- **Deleted files** stay visible as red ghost rows (tracked from the workspace
  file watcher).
- Edited-only mode when you only care about the diff surface.
- A full-screen tree panel (`/filetree-panel`) for browsing the whole tree.
- A server-side tool, `filetree_edited_files`, namespaced under `filetree`.
- Walks the project through the OpenCode `file.list` API — no `node:fs`, no
  filesystem permissions, and it works against a remote server too.

## Install

```sh
opencode plugin add opencode-file-tree
```

Or add it to `opencode.json(c)` yourself:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-file-tree"]
}
```

The package exposes both entrypoints (`./index.ts` for the server tool and
`./tui.tsx` for the terminal UI), so a single entry loads both halves.

To keep it active as a terminal-only plugin while connected to a remote server,
configure it in `cli.json` instead:

```jsonc title="cli.json"
{
  "plugins": ["opencode-file-tree"]
}
```

### From a local checkout

```jsonc title="opencode.jsonc"
{
  "plugins": ["/absolute/path/to/opencode-file-tree"]
}
```

A local plugin **directory** is loaded by convention: a root `index.ts` (server)
and `tui.tsx` (terminal UI). The package root ships exactly those files, so the
same directory works as a local plugin or as an installed npm package.

## Configure

Pass options with the object form of a `plugins` entry:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-file-tree",
      "options": {
        "visible": true,
        "onlyEdited": false,
        "includeSubagents": true,
        "maxDepth": 4,
        "maxRows": 160,
        "expandDepth": 2,
        "concurrency": 8,
        "ignore": ["tmp", "fixtures"]
      }
    }
  ]
}
```

| Option             | Default   | Range      | Description                                                        |
| ------------------ | --------- | ---------- | ------------------------------------------------------------------ |
| `visible`          | `true`    |            | Render the sidebar tree at all.                                    |
| `onlyEdited`       | `false`   |            | Start in edited-only mode.                                         |
| `includeSubagents` | `false`   |            | Also highlight files touched by child (subagent) sessions.         |
| `maxDepth`         | `4`       | 1–12       | How many directory levels to walk below the project root.          |
| `maxRows`          | `160`     | 10–2000    | Cap on collected/rendered rows, to keep the tree bounded.          |
| `expandDepth`      | `2`       | 1–12       | Directories expanded by default in the **sidebar** view.           |
| `concurrency`      | `8`       | 1–32       | Maximum concurrent `file.list` requests while walking.             |
| `ignore`           | `[]`      |            | Extra path segments to skip, on top of the built-in ignore list.   |

`maxDepth`, `maxRows`, `expandDepth`, and `concurrency` are clamped to the ranges
shown. `ignore` matches whole path segments, so `"tmp"` skips `tmp/`,
`src/tmp/`, and a file literally named `tmp`. The built-in ignore list already
covers `node_modules`, `.git`, `dist`, `build`, `.next`, `target`, `vendor`,
`__pycache__`, `coverage`, and friends.

## Commands

Available from the command palette and, where noted, as slash commands.

| Command / palette entry                       | Slash             | What it does                                  |
| --------------------------------------------- | ----------------- | --------------------------------------------- |
| File tree: show / hide                        | `/filetree`       | Toggle the sidebar tree (`tree`, `ft` aliases). |
| File tree: toggle edited-only view            | `/filetree-mode`  | Show just the edited files.                   |
| File tree: refresh                            | `/filetree-refresh` | Rescan the tree.                            |
| File tree: expand all folders                 | `/filetree-expand` | Open every folder.                           |
| File tree: collapse all folders               | `/filetree-collapse` | Close every folder.                        |
| File tree: open full tree panel               | `/filetree-panel` | Open the whole tree in the session panel.     |
| File tree: open full tree panel (full screen) |                   | Same, requesting a full-screen panel.         |
| File tree: set depth                          |                   | Dialog to choose the sidebar expansion depth. |

Clicking a folder row toggles just that folder; expand/collapse-all overrides
every folder at once (they reset any per-folder toggles).

The full-tree panel is a `session.panel` contribution: the host owns its sizing
and focus, and the tree scrolls inside it.

## How highlighting works

For each session the plugin reads the **full** message history (paginated
`message.list`; the live in-memory store only keeps a small recent window) and
combines three sources:

1. **Editing-tool metadata** — the built-in `edit` tool reports
   `{ file, status, additions, deletions }` per changed file, giving exact line
   stats.
2. **Editing tool-call inputs** (`edit`, `write`, `patch`, and common variants) —
   a fallback that counts lines from the old/new strings, `content`, or `patch`,
   and reads the result text (`"Created…"` vs `"Wrote…"`) to tell added from
   modified.
3. **`snapshot.files`** on assistant messages — authoritative for *which* files
   changed when the other two are unavailable.

Paths are made relative to the project root; files outside the project are
ignored. Markers follow status: `+` added, `●` modified, `−` deleted, with a
count suffix when a file was touched multiple times (e.g. `●3`), and `+N`/`-M`
line stats when counts are known. Colors come from the active theme's diff/text
tokens.

The view refreshes when a tool call completes or fails, when an execution
succeeds, and when the workspace file watcher reports a relevant change. A file
the watcher reports as unlinked is kept as a red ghost row for the rest of the
session.

## Server tool

The server half registers `filetree_edited_files` under the `filetree`
namespace:

- **Input**: `sessionID` (optional; defaults to the calling session) and
  `includeSubagents` (optional boolean).
- **Output**: a human-readable list (`A`/`M`/`D`, path, `+N`/`-M`, touch count),
  plus metadata
  `{ sessionID, sessions, count, files: [{ path, status, count, additions, deletions }] }`.

This exposes the same data the sidebar highlights, so an agent can answer "what
did this session change?" without guessing.

## Package layout

```
opencode-file-tree/
├── index.ts                 # server plugin entry (tool registration)
├── tui.tsx                  # terminal UI entry (slot, commands, events)
└── src/
    ├── components/
    │   └── FileTree.tsx     # Solid component for the sidebar and panel
    └── lib/
        ├── scan.ts          # bounded recursive tree walk over file.list
        ├── edited.ts        # derive the edited-file set (status + line counts)
        ├── messages.ts      # paginated full-history message fetch
        ├── render.ts        # flatten tree / edited list into rows
        ├── config.ts        # option parsing and UI/settings state
        ├── ignore.ts        # path-segment ignore matching
        └── paths.ts         # path helpers
```

Sources ship as TypeScript with **no build step**; OpenCode resolves the package
entries (or the local directory's `index.ts` / `tui.tsx`) at runtime.

> Note on loading: for an installed **npm package**, the `exports` map selects
> the server entry (`"."`) and the terminal entry (`"./tui"`). For a local
> **absolute directory**, OpenCode resolves `index`/`server` and `tui` by
> convention and ignores `exports`. Shipping `index.ts` and `tui.tsx` at the
> package root satisfies both paths.

## Requirements

- OpenCode v2 (`@opencode/plugin` `>= 2.0.0`).
- Rendering uses OpenTUI, supplied by OpenCode at runtime:
  `@opentui/core` and `@opentui/solid` `>= 0.5.17`, and `solid-js` `>= 1.9.0`.
  They are optional peer dependencies.

## Development

```sh
npm install
npm run typecheck
npm run smoke   # walks the tree against a running local service; skips if none
```

## License

MIT © Ady
