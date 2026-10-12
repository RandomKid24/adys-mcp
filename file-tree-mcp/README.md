# file-tree-mcp

A file tree for AI coding agents, in two parts:

1. **Universal MCP server** — works in any MCP client. Tools: `file_tree` (project tree, changed files tagged `[A]` `[M]` `[D]` with `+N -M`) and `edited_files` (uncommitted changes, from git).
2. **OpenCode sidebar plugin** — a live tree that highlights files as the agent edits them ([jump to it](#opencode-sidebar-plugin)).

## Install (MCP server)

Needs Node >= 18 and `git`.

```bash
npx -y github:RandomKid24/adys-mcp install
```

Detects Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, OpenCode and Codex, and registers the server in each (on OpenCode it installs the sidebar plugin instead; on Windows it wraps `npx` in `cmd /c`). Backs up every config it edits to `.bak`, skips configs it can't safely parse, and is safe to re-run. Restart your client afterwards.

### Manual config

The project root is the client's cwd, or the first argument.

```jsonc
// Claude Desktop / Cursor / Windsurf / Gemini CLI ("mcpServers")
{ "file-tree": { "command": "npx", "args": ["-y", "github:RandomKid24/adys-mcp"] } }
```

```bash
claude mcp add file-tree -- npx -y github:RandomKid24/adys-mcp
```

### Limits

- No sidebar over MCP (MCP has no UI) — use the OpenCode plugin for that.
- `edited_files` reports all uncommitted git changes, not only the agent's.

### Development

The server ships prebuilt as `mcp.js` so `npx` needs no build. After editing `mcp.ts` or `src/`, run `npm run build` and commit `mcp.js`.

---

# OpenCode sidebar plugin

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
- **Click a file to open it in an editor dialog** — edit, `ctrl+s` to save, `esc` to close (text files up to 512 KB; saves through the OpenCode `file.write` API).
- A fixed-height, scrollable sidebar (mouse wheel) — never takes over the screen.
- A server-side tool, `filetree_edited_files`, namespaced under `filetree`.
- Walks the project through the OpenCode `file.list` API — no `node:fs`, no
  filesystem permissions, and it works against a remote server too.

## Install

```sh
opencode plugin add /absolute/path/to/file-tree-mcp
```

Or add it to `opencode.json(c)` yourself:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/file-tree-mcp"]
}
```

The package exposes both entrypoints (`./index.ts` for the server tool and
`./tui.tsx` for the terminal UI), so a single entry loads both halves.

To keep it active as a terminal-only plugin while connected to a remote server,
configure it in `cli.json` instead:

```jsonc title="cli.json"
{
  "plugins": ["/absolute/path/to/file-tree-mcp"]
}
```

### From a local checkout

```jsonc title="opencode.jsonc"
{
  "plugins": ["/absolute/path/to/file-tree-mcp"]
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
      "package": "/absolute/path/to/file-tree-mcp",
      "options": {
        "visible": true,
        "onlyEdited": false,
        "includeSubagents": true,
        "maxDepth": 4,
        "maxRows": 160,
        "expandDepth": 1,
        "sidebarRows": 15,
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
| `sidebarRows`      | `15`      | 3–200      | Height of the sidebar tree; scroll for the rest.                   |
| `expandDepth`      | `1`       | 1–12       | Directories expanded by default in the **sidebar** view.           |
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
| File tree: show / hide                        | `/filetree`       | Toggle the sidebar tree. |
| File tree: toggle edited-only view            | `/filetree-mode`  | Show just the edited files.                   |
| File tree: refresh                            | `/filetree-refresh` | Rescan the tree.                            |

Clicking a folder row toggles just that folder.

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
file-tree-mcp/
├── mcp.ts / mcp.js          # universal MCP server (source / prebuilt)
├── index.ts                 # OpenCode server plugin entry
├── tui.tsx                  # terminal UI entry (slot, commands, events)
└── src/
    ├── components/
    │   └── FileTree.tsx     # Solid component for the sidebar
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
