import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { Run } from '../types'

const PANE = {
  plugin: 'ci-watch',
  component: 'Pane',
  requestId: 'ci-watch',
  props: {
    title: 'Testy i CI',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const T0 = 1_700_000_000_000

const running: Run = {
  id: 'log:b1',
  kind: 'log',
  label: 'pytest -v tests/',
  status: 'running',
  framework: 'pytest',
  total: 245,
  done: 24,
  passed: 22,
  failed: 2,
  skipped: 0,
  current: 'tests/test_api.py::test_login_redirect',
  failures: ['tests/test_api.py::test_refund', 'tests/test_api.py::test_delete'],
  tail: [],
  carry: '',
  offset: 100,
  taskId: 'b1',
  path: 'C:/tmp/b1.output',
  startedAt: T0,
  firstProgressAt: T0 + 1000,
  lastOutputAt: T0 + 60_000,
  lastChangeAt: T0 + 60_000,
  stallMs: 300_000,
  isAlerted: false,
  wakeOnFinish: false,
}

const gh: Run = {
  ...running,
  id: 'gh:42',
  kind: 'gh',
  label: 'CI · fix login',
  framework: undefined,
  status: 'failed',
  ghRunId: '42',
  url: 'https://github.com/acme/web/actions/runs/42',
  jobs: [
    { name: 'lint', status: 'completed', conclusion: 'success', stepsDone: 4, stepsTotal: 4 },
    { name: 'e2e', status: 'completed', conclusion: 'failure', step: 'Run playwright', stepsDone: 6, stepsTotal: 6 },
  ],
  failures: ['e2e › Run playwright'],
  endedAt: T0 + 120_000,
}

function seed(on: On, runs: Run[]) {
  on('state.get', (_, e, next) => {
    if (e.key === 'runs') return { value: { value: { shape: 'runs-1', value: runs }, version: 1 } }
    if (e.key === 'now') return { value: { value: T0 + 90_000, version: 1 } }
    return next(e)
  })
}

test('a running test shows n/total, the current test and its failures, on every surface', async ($, on) => {
  seed(on, [running, gh])
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /pytest -v tests/ }))?.text).toBe('pytest -v tests/')
    expect(await ui.find({ type: 'Text', text: /test_login_redirect/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /test_refund/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Run playwright/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the widget is one glance: progress and the current test', async ($, on) => {
  seed(on, [running])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  expect((await ui.find({ type: 'Text', text: /24\/245/ }))?.text).toContain('✗ 2')
  await ui.unmount()
})

test('nothing tracked: the pane says how runs get there', async ($, on) => {
  seed(on, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing is running in this session/ })).toBeTruthy()
  await ui.unmount()
})

test('a stored value from another shape is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: [{ id: 'old' }], version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Nothing is running in this session/ })).toBeTruthy()
  await ui.unmount()
})
