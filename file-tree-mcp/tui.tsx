import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { FileTree } from "./src/components/FileTree.tsx"
import { resolveConfig, type SettingsState, type UiState } from "./src/lib/config.ts"
import { isIgnored } from "./src/lib/ignore.ts"
import { captureSession } from "./src/memory/capture.ts"
import { openEditor } from "./src/components/Editor.tsx"
import { toRelative } from "./src/lib/paths.ts"

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
            onSaved={() => bump("editTick")}
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
      context.data.on("session.execution.succeeded", (event) => {
        bump("editTick")
        const location = context.location ?? context.data.location.default()
        void captureSession(context.client, location, location.directory, event.data.sessionID)
      }),
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
          id: "filetree.find",
          title: "File tree: find and edit a file",
          group: "File tree",
          palette: true,
          slash: { name: "filetree-find" },
          run: async () => {
            const query = await context.ui.dialog.prompt({ title: "Find file", placeholder: "part of a file name" })
            if (!query?.trim()) return
            const location = context.location ?? context.data.location.default()
            const found = await context.client.file.find({ location, query: query.trim(), type: "file", limit: 50 })
            const options = found.data.map((entry) => ({ title: entry.path, value: entry.path }))
            if (options.length === 0) return void context.ui.toast.show({ message: `No files match "${query}"`, variant: "warning" })
            const path = await context.ui.dialog.select({ title: "Open file", options })
            if (path) openEditor(context, path, location, () => bump("editTick"))
          },
        },
        {
          id: "filetree.new",
          title: "File tree: new file",
          group: "File tree",
          palette: true,
          slash: { name: "filetree-new" },
          run: async () => {
            const path = (await context.ui.dialog.prompt({ title: "New file", placeholder: "src/example.ts" }))?.trim()
            if (!path || path.startsWith("/") || path.includes("..")) return
            const location = context.location ?? context.data.location.default()
            // Never truncate an existing file: only create when the read fails.
            const exists = await context.client.file.read({ location, path }).then(() => true, () => false)
            if (!exists) {
              await context.client.file.write({ location, path, payload: new Uint8Array() })
              bump("refresh")
            }
            openEditor(context, path, location, () => bump("editTick"))
          },
        },
        {
          id: "filetree.refresh",
          title: "File tree: refresh",
          group: "File tree",
          palette: true,
          slash: { name: "filetree-refresh" },
          run: () => bump("refresh"),
        },
      ],
    }))

    return () => {
      for (const stop of stops) stop()
      if (timer) clearTimeout(timer)
    }
  },
})
