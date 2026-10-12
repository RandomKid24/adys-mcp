<div align="center">

# ady's mcps

**Small, sharp tools for AI coding agents.**

</div>

## [`file-tree-mcp`](./file-tree-mcp)

See your project the way your agent does — and what it just changed.

```
my-project
src/
  components/
    FileTree.tsx  [M]  +517 -73
  lib/
    render.ts     [A]  +169 -0
README.md         [D]  +0 -202
```

| Tool           | What it does                                                                 |
| -------------- | ---------------------------------------------------------------------------- |
| `file_tree`    | Bounded project tree, noise ignored, changed files tagged `[A]` `[M]` `[D]` with line counts. |
| `edited_files` | Everything uncommitted in the repo, straight from git.                       |
| `search_files` | Find files by path.                                                          |
| `read_file`    | Read a project text file, optionally a line range.                           |

**One command, every client.** Detects Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Kiro, Antigravity, Gemini CLI and OpenCode, and registers itself in each:

```bash
npx -y github:RandomKid24/adys-mcp install
```

Undo with `npx -y github:RandomKid24/adys-mcp uninstall`.

**On Claude Code you also get a `/tree` pane** — a free file tree with git changes that draws in the terminal itself, so it costs **no tokens** (the MCP tools are called by the model and do). Open it with `/tree`.

**On OpenCode it goes further:** a live sidebar that highlights files as the agent edits them. See the [package README](./file-tree-mcp/README.md).

## [`project-memory`](./file-tree-mcp/src/memory) — one memory for every AI tool

A shared, git-aware memory graph for your project. Decisions (with the **why** and what was rejected), notes, tasks and sessions, linked to the files they concern, stored in `.memory/graph.json` in your repo — readable, committable, shared by Claude Code, Codex, Cursor, OpenCode, Kiro and the rest.

| Tool | What it does |
| ---- | ------------ |
| `remember` | Save a decision / note / task, linked to files. |
| `recall` | Search memory; returns only the matching memories + their files. |
| `file_memory` | Everything remembered about one file. |
| `log_session` | Record what a session did. |
| `stale_memories` | Memories whose files changed in git since — likely outdated. |
| `link_memories` / `forget` | Connect or delete memories. |

- **Sessions fill in automatically** in Claude Code (via the `/tree` mod) and OpenCode (via the sidebar plugin): files touched are recorded on a per-day session node. Other clients save through the tools.
- **See it:** `npx -y github:RandomKid24/adys-mcp graph` opens a local web graph — drag nodes, filter, time-travel slider, orange ring = possibly outdated. Costs no tokens.
- Installed by the same one command above (`install` registers both servers).

## `env-doctor` — find out why it won't run

One call (`diagnose`) answers the "works on my machine" questions that otherwise cost a dozen shell commands:

| Tool | What it checks |
| ---- | -------------- |
| `diagnose` | Everything below, as one report with fixes. |
| `check_tools` | node / python / go / rust / docker / package manager vs what `package.json` engines, `.nvmrc`, `go.mod`, `pyproject.toml` require. |
| `check_deps` | Dependencies installed? Lockfile newer than `node_modules`? |
| `check_env` | `.env` vs `.env.example`, and variables read in code but defined nowhere. **Names only — values are never read or shown.** |
| `check_ports` | Busy ports and the process holding them (project's own ports by default). |
| `check_docker` | Is the daemon running? |
| `explain_error` | Paste an error → likely cause and which check to run. |

Humans can skip the AI entirely: `npx -y github:RandomKid24/adys-mcp doctor --report` prints the same report (exit code 1 if anything failed — handy in CI or a pre-start script). Installed by the same `install` command.

## `mcp-installer` — add any MCP to every tool with one command

Editing five config files in five formats (and the Windows `cmd /c` workaround) is the annoying part of using MCP. This does it for you:

```bash
npx -y github:RandomKid24/adys-mcp add context7                      # from the built-in catalog
npx -y github:RandomKid24/adys-mcp add mytool -- npx -y some-mcp     # any command
npx -y github:RandomKid24/adys-mcp add api --url https://host/mcp    # remote server (bridged via mcp-remote)
npx -y github:RandomKid24/adys-mcp add mytool --env API_KEY=abc --client cursor,codex
npx -y github:RandomKid24/adys-mcp list                              # which server is in which client
npx -y github:RandomKid24/adys-mcp remove mytool
npx -y github:RandomKid24/adys-mcp catalog
```

Works with Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Kiro, Antigravity, Gemini CLI and OpenCode. Every config it edits is backed up to `.bak` first, existing servers are never touched, it skips configs it can't parse safely, and `--dry-run` shows what would change. `--env` values are stored in plain text in each client's config (same as editing it by hand). No tokens involved — it's a command you run. Catalog commands come from each project's docs; override any with `-- <command>`.

## License

MIT © Ady
