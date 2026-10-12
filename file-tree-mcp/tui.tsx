import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { FileTree } from "./src/components/FileTree.tsx"
import { resolveConfig, type SettingsState, type UiState } from "./src/lib/config.ts"
import { isIgnored } from "./src/lib/ignore.ts"
import { toRelative } from "./src/lib/paths.ts"

/** Selection name for the full-tree `session.panel` view. */
const PANEL_NAME = "opencode-file-tree.tree"

export default Plugin.define({
  id: "opencode-file-tree.tui",
  setup(context) {
    const config = resolveConfig(context.options)

    const [ui, updateUi] = context.storage.memory<UiState>("filetree.ui", {
      initial: {
        visible: config.visible,
        onlyEdited: config.onlyEdited,
        refresh: 0,
        editTick: 0,
        expanded: {},
        removed: [],
      },
    })

    /** Toggle a directory's expanded state from the tree component. */
    const setDirOpen = (path: string, open: boolean): void => {
      updateUi((draft) => {
        draft.expanded[path] = open
      })
    }

    const [settings, updateSettings] = context.storage.store<SettingsState>("filetree.settings", {
      initial: {
        maxDepth: config.maxDepth,
        maxRows: config.maxRows,
        expandDepth: config.expandDepth,
      },
    })

    context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <Show when={ui.visible}>
          <FileTree
            sessionID={input.sessionID}
            config={config}
            ui={ui}
            settings={settings}
            onToggleDir={setDirOpen}
          />
        </Show>
      ),
    })

    // Full-tree view in the focusable session panel. The host owns sizing,
    // focus and full-screen presentation; this contribution renders only when
    // its selection name is the one the panel was opened with.
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME}>
          <FileTree
            sessionID={panel.sessionID}
            config={config}
            ui={ui}
            settings={settings}
            variant="panel"
            focused={panel.focused}
            onToggleDir={setDirOpen}
          />
        </Show>
      ),
    })

    const bump = (key: "editTick" | "refresh"): void => {
      updateUi((draft) => {
        draft[key] += 1
      })
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        bump("refresh")
      }, 400)
    }

    const stops = [
      // A completed/failed tool is the moment an edit lands; refresh highlights.
      context.data.on("session.tool.success", () => bump("editTick")),
      context.data.on("session.tool.failed", () => bump("editTick")),
      context.data.on("session.execution.succeeded", () => bump("editTick")),
      // The workspace watcher fires for real filesystem changes (including edits
      // made outside the agent), so rescan the tree and track deletions.
      context.data.on("filesystem.changed", (event) => {
        const directory = context.location?.directory
        if (directory && event.location?.directory && event.location.directory !== directory) return
        const relative = toRelative(directory ?? "", event.data.file)
        if (relative && isIgnored(relative, config.ignore)) return
        if (relative) {
          const removed = event.data.event === "unlink"
          updateUi((draft) => {
            const index = draft.removed.indexOf(relative)
            if (removed && index === -1) draft.removed.push(relative)
            else if (!removed && index !== -1) draft.removed.splice(index, 1)
          })
        }
        bump("editTick")
        scheduleRefresh()
      }),
    ]

    context.keymap.layer(() => ({
      mode: "global",
      priority: 5,
      commands: [
        {
          id: "filetree.toggle",
          title: "File tree: show / hide",
          group: "File tree",
          palette: true,
          slash: { name: "filetree" },
          run: () =>
            updateUi((draft) => {
              draft.visible = !draft.visible
            }),
        },
        {
          id: "filetree.mode",
          title: "File tree: toggle edited-only view",
          group: "File tree",
          palette: true,
          slash: { name: "filetree-mode" },
          run: () =>
            updateUi((draft) => {
              draft.onlyEdited = !draft.onlyEdited
            }),
        },
        {
          id: "filetree.refresh",
          title: "File tree: refresh",
          group: "File tree",
          palette: true,
          slash: { name: "filetree-refresh" },
          run: () => bump("refresh"),
        },
        {
          id: "filetree.panel",
          title: "File tree: open full tree panel",
          group: "File tree",
          palette: true,
          slash: { name: "filetree-panel" },
          run: () => {
            context.ui.panel.open(PANEL_NAME)
          },
        },
      ],
    }))

    return () => {
      for (const stop of stops) stop()
      if (timer) clearTimeout(timer)
    }
  },
})
