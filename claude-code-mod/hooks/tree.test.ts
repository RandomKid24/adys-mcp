import { expect, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code'

// The harness loads this plugin itself; the test's hook stands for the engine beneath it.
test('a tool call passes through the mod', async ($: Engine, on: On) => {
  on('tool.call', async () => ({ result: { text: 'ok' } }) as never)
  expect(await $.tool.call({ tool: 'Read', file_path: 'README.md' })).toBeDefined()
})
