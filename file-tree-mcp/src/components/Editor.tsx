import type { LocationRef } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import { createResource, createSignal, Show } from "solid-js"

const MAX_BYTES = 512 * 1024

interface Loaded {
  text?: string
  error?: string
}

/** Edit a project file in a dialog: ctrl+s saves, esc closes. */
export function Editor(props: { path: string; location: LocationRef; onSaved: () => void }) {
  const ctx = usePlugin()
  const theme = ctx.theme.surface("dialog")
  const [dirty, setDirty] = createSignal(false)
  const [status, setStatus] = createSignal<string | undefined>(undefined)
  let area: { plainText: string } | undefined

  const [file] = createResource(async (): Promise<Loaded> => {
    try {
      const bytes = await ctx.client.file.read({ location: props.location, path: props.path })
      if (bytes.byteLength > MAX_BYTES) return { error: `Too large to edit here (${Math.round(bytes.byteLength / 1024)} KB).` }
      if (bytes.includes(0)) return { error: "Binary file — not editable." }
      return { text: new TextDecoder().decode(bytes) }
    } catch (error) {
      return { error: `Could not read file: ${(error as Error).message}` }
    }
  })

  const save = async (): Promise<void> => {
    if (!area) return
    try {
      await ctx.client.file.write({
        location: props.location,
        path: props.path,
        payload: new TextEncoder().encode(area.plainText),
      })
      setDirty(false)
      setStatus("saved")
      props.onSaved()
      ctx.ui.toast.show({ message: `Saved ${props.path}`, variant: "success", duration: 1500 })
    } catch (error) {
      setStatus(`save failed: ${(error as Error).message}`)
    }
  }

  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text wrapMode="none" fg={theme.text.base}>
          <span style={{ fg: theme.hue.accent[500] }}>{"✎ "}</span>
          {props.path}
          <Show when={dirty()}>
            <span style={{ fg: theme.text.feedback.warning.base }}>{"  ● unsaved"}</span>
          </Show>
          <Show when={!dirty() && status()}>
            <span style={{ fg: theme.text.feedback.success.base }}>{`  ✓ ${status()}`}</span>
          </Show>
        </text>
        <text wrapMode="none" fg={theme.text.muted}>{"ctrl+s save · esc close"}</text>
      </box>

      <Show when={file()} fallback={<text fg={theme.text.muted}>Loading…</text>}>
        {(loaded: () => Loaded) => (
          <Show
            when={loaded().text !== undefined}
            fallback={<text fg={theme.text.feedback.error.base}>{loaded().error}</text>}
          >
            <textarea
              ref={(node: { plainText: string }) => (area = node)}
              focused
              height={24}
              initialValue={loaded().text}
              wrapMode="none"
              textColor={theme.text.base}
              backgroundColor={theme.background.base}
              focusedBackgroundColor={theme.background.raised.base}
              keyBindings={[{ name: "s", ctrl: true, action: "submit" }]}
              onSubmit={() => void save()}
              onContentChange={() => {
                setDirty(true)
                setStatus(undefined)
              }}
            />
          </Show>
        )}
      </Show>
    </box>
  )
}
