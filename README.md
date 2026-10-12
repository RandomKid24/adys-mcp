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

## License

MIT © Ady
