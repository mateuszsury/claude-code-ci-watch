import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// A fake `gh` beneath the plugin: what the GitHub runs and PR checks look like
// at each moment is set by the test.
type Fake = {
  runs: Record<string, { status: string; conclusion: string | null }>
  checks: { name: string; state: string; bucket: string; workflow: string }[]
  prompts: string[]
  calls: string[][]
}

function engine(on: On, clock: { sleep: (ms: number) => Promise<void> }): Fake {
  const fake: Fake = { runs: {}, checks: [], prompts: [], calls: [] }
  on('command.register', () => ({ value: { command: 'ci' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__ci-watch__x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    fake.prompts.push(e.text)
    return { text: e.text }
  })
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    fake.calls.push(argv)
    const out = (stdout: unknown, exitCode = 0) => ({
      value: { exitCode, stdout: JSON.stringify(stdout), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv[1] === 'run' && argv[2] === 'list') {
      return out(
        Object.keys(fake.runs).map(id => ({ databaseId: Number(id), workflowName: `wf${id}`, displayTitle: 'fix', headSha: '6fb617a0000000', createdAt: '2026-11-20T10:00:00Z', url: `https://github.com/acme/web/actions/runs/${id}` })),
      )
    }
    if (argv[1] === 'run' && argv[2] === 'view') {
      const r = fake.runs[argv[3]!]!
      return out({ ...r, workflowName: `wf${argv[3]}`, displayTitle: 'fix', jobs: [{ name: 'build', status: r.status, conclusion: r.conclusion, steps: [] }] })
    }
    if (argv[1] === 'pr' && argv[2] === 'checks') return out(fake.checks, fake.checks.some(c => c.bucket === 'pending') ? 8 : 0)
    if (argv[1] === 'pr' && argv[2] === 'view') return out({ number: 12, title: 'Fix login', url: 'https://github.com/acme/web/pull/12' })
    return out('', 1)
  })
  on('tool.call', async (_, e) => {
    const command = String((e as unknown as { command?: unknown }).command)
    if (command.startsWith('git push')) {
      return { result: { stdout: '', stderr: 'To https://github.com/acme/web.git\n   1a2b3c4..6fb617a  main -> main\n', interrupted: false }, text: '' }
    }
    if (command.startsWith('slow:')) await clock.sleep(15_000)
    return { result: { stdout: 'ok\n', stderr: '', interrupted: false }, text: 'ok' }
  })
  return fake
}

const status = async ($: Engine) => {
  const res = await $.tool.call({ tool: 'mcp__ci-watch__status' })
  return res.text ?? JSON.stringify(res.result)
}

test('a push: its workflows are found and tracked, and the agent hears once, when all have ended', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-20T10:00:00Z') })
  const fake = engine(on, clock)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  fake.runs = { '11': { status: 'in_progress', conclusion: null }, '12': { status: 'queued', conclusion: null } }
  await $.tool.call({ tool: 'Bash', command: 'git push' })

  await clock.advance(6_000)
  const listed = fake.calls.find(a => a[1] === 'run' && a[2] === 'list')!
  expect(listed).toEqual(expect.arrayContaining(['--branch', 'main', '-R', 'acme/web']))
  expect(await status($)).toContain('GitHub run 11')
  expect(await status($)).toContain('GitHub run 12')

  fake.runs['11'] = { status: 'completed', conclusion: 'success' }
  fake.runs['12'] = { status: 'in_progress', conclusion: null }
  await clock.advance(16_000)
  expect(fake.prompts).toEqual([])

  fake.runs['12'] = { status: 'completed', conclusion: 'failure' }
  await clock.advance(16_000)
  expect(fake.prompts.length).toBe(1)
  expect(fake.prompts[0]).toContain('for the push of 6fb617a')
  expect(fake.prompts[0]).toContain('1 of 2 failed')

  await clock.advance(200_000)
  expect(fake.prompts.length).toBe(1)
})

test('gh pr checks: a card for the checks, and a message when they pass', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-20T10:00:00Z') })
  const fake = engine(on, clock)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  fake.checks = [{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending', workflow: 'CI' }]
  await $.tool.call({ tool: 'Bash', command: 'gh pr checks 12 --watch' })

  await clock.advance(2_000)
  expect(await status($)).toContain('PR #12 · Fix login')
  expect(await status($)).toContain('Running')

  fake.checks = [{ name: 'test', state: 'SUCCESS', bucket: 'pass', workflow: 'CI' }]
  await clock.advance(16_000)
  expect(fake.prompts.length).toBe(1)
  expect(fake.prompts[0]).toContain('The checks of PR 12 finished: ✅ passed')
})

test('a quick foreground check gets no card; a long one does, with its result', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-20T10:00:00Z') })
  engine(on, clock)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.tool.call({ tool: 'Bash', command: 'npm run typecheck' })
  expect(await status($)).toContain('nothing is tracked')

  const long = $.tool.call({ tool: 'Bash', command: 'slow: ; cargo build --release' })
  await clock.advance(11_000)
  expect(await status($)).toContain('Running')
  await clock.advance(5_000)
  await long
  const after = await status($)
  expect(after).toContain('slow: ; cargo build --release')
  expect(after).toContain('Passed')
})
