import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const LOG = 'collected 5 items\n\ntests/test_a.py::test_one PASSED  [ 20%]\ntests/test_a.py::test_two PASSED  [ 40%]\n'

function engine(on: On, log = LOG) {
  const prompts: string[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'ci' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ci-watch__x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', () => ({ value: { size: log.length, mtimeMs: 0, kind: 'file', isLink: false } }))
  on('fs.read', () => ({ value: log }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    text: 'Command running in background with ID: b1. Output is being written to: /tmp/tasks/b1.output. You will be notified when it completes',
  }))
  return { prompts, toasts }
}

test('a background test run that goes quiet wakes the idle agent once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const seen = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pytest -v tests/', run_in_background: true })

  await clock.advance(4_000)
  const status = await $.tool.call({ tool: 'mcp__ci-watch__status' })
  expect(status.text ?? JSON.stringify(status.result)).toContain('2/5')
  expect(seen.prompts).toEqual([])

  await clock.advance(5 * 60_000)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('look stuck')
  expect(seen.prompts[0]).toContain('tests/test_a.py::test_two')

  await clock.advance(5 * 60_000)
  expect(seen.prompts.length).toBe(1)
})

test('the task notification ends the run with its exit code', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pytest -v tests/', run_in_background: true })
  await clock.advance(2_000)
  await $.session.append({
    door: 'delivery',
    origin: { kind: 'model', model: 'test' },
    uuid: 'u1',
    message: {
      type: 'user',
      content: [
        {
          type: 'text',
          text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "pytest" completed (exit code 1)</summary>\n</task-notification>',
        },
      ],
    },
  })
  const status = await $.tool.call({ tool: 'mcp__ci-watch__status' })
  expect(status.text ?? JSON.stringify(status.result)).toContain('Failed')
})

test('failures in the output fail the run even when the exit code was swallowed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  engine(on, `${LOG}tests/test_a.py::test_three FAILED  [ 60%]\n`)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pytest -v tests/ || true', run_in_background: true })
  await clock.advance(2_000)
  await $.session.append({
    door: 'delivery',
    origin: { kind: 'model', model: 'test' },
    uuid: 'u2',
    message: {
      type: 'user',
      content: [{ type: 'text', text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>completed (exit code 0)</summary>\n</task-notification>' }],
    },
  })
  const status = await $.tool.call({ tool: 'mcp__ci-watch__status' })
  const text = status.text ?? JSON.stringify(status.result)
  expect(text).toContain('Failed')
  expect(text).toContain('test_three')
})
