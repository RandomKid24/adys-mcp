import { expect, test } from 'claude-code/testing'

const draw = async ($: any, id: string) => {
  const pane = await $.ui.mount({ plugin: 'file-tree-pane', surface: 'terminal', component: 'Pane', props: { requestId: id }, requestId: id })
  return JSON.stringify(await pane.drawn())
}

test('every pane mounts and draws', async ($: any) => {
  expect(await draw($, 'file-tree')).toContain('find')
  expect(await draw($, 'file-view')).toContain('click a file')
  expect(await draw($, 'file-edit')).toContain('click a file')
  expect(await draw($, 'file-find')).toContain('/find')
})
