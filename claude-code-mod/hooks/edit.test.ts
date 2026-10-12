import { expect, test } from 'claude-code/testing'

test('the editor pane draws its empty state', async ($: any) => {
  const pane = await $.ui.mount({ plugin: 'file-tree-pane', surface: 'terminal', component: 'Pane', props: { requestId: 'file-edit' }, requestId: 'file-edit' })
  expect(JSON.stringify(await pane.drawn())).toContain('click a file')
})
