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

**Works everywhere** — Claude Code, Cursor, Claude Desktop, Codex, OpenCode… any MCP client:

```bash
claude mcp add file-tree -- npx -y github:RandomKid24/adys-mcp
```

**On OpenCode it goes further:** a live sidebar that highlights files as the agent edits them. See the [package README](./file-tree-mcp/README.md).

## License

MIT © Ady
