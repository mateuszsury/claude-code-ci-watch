import { expect, test } from 'claude-code/testing'

import type { Run } from '../types'
import { checksSnapshot, finishedToReport, newRuns, pushedTo, runSnapshot } from '../hooks/github'
import type { GhCheck } from '../hooks/github'

// `gh pr checks 15108 -R cli/cli --json name,state,bucket,workflow,link` (gh 2.86), trimmed.
const CHECKS: GhCheck[] = [
  { bucket: 'pass', link: 'https://github.com/cli/cli/runs/135760909816', name: 'CodeQL', state: 'SUCCESS', workflow: '' },
  { bucket: 'skipping', link: 'https://github.com/cli/cli/actions/runs/44580806364/job/1', name: 'ready-for-review', state: 'SKIPPED', workflow: 'PR Triaging' },
  { bucket: 'pass', link: 'https://github.com/cli/cli/actions/runs/44580805818/job/2', name: 'govulncheck', state: 'SUCCESS', workflow: 'Security' },
]

test('PR checks: all ended and none failed is passed; a pending one keeps it running', async () => {
  const done = checksSnapshot(CHECKS)
  expect([done.status, done.done, done.total, done.passed, done.skipped]).toEqual(['passed', 3, 3, 2, 1])
  const live = checksSnapshot([...CHECKS, { bucket: 'pending', name: 'test (ubuntu)', state: 'IN_PROGRESS', workflow: 'Tests' }])
  expect([live.status, live.current]).toEqual(['running', 'Tests › test (ubuntu)'])
  const bad = checksSnapshot([...CHECKS, { bucket: 'fail', name: 'lint', state: 'FAILURE', workflow: 'Lint' }])
  expect([bad.status, bad.failures]).toEqual(['failed', ['Lint › lint']])
  expect(checksSnapshot([]).status).toBe('queued')
})

test('a run: steps count, the live step is named, a failed job ends it failed', async () => {
  const live = runSnapshot({
    status: 'in_progress',
    conclusion: null,
    jobs: [
      { name: 'lint', status: 'completed', conclusion: 'success', steps: [{ name: 'a', status: 'completed', conclusion: 'success' }] },
      {
        name: 'e2e',
        status: 'in_progress',
        conclusion: null,
        steps: [
          { name: 'checkout', status: 'completed', conclusion: 'success' },
          { name: 'Run playwright', status: 'in_progress', conclusion: null },
          { name: 'upload', status: 'queued', conclusion: null },
        ],
      },
    ],
  })
  expect([live.status, live.done, live.total, live.current]).toEqual(['running', 2, 4, 'e2e › Run playwright'])
  const failed = runSnapshot({ status: 'completed', conclusion: 'failure', jobs: [{ name: 'e2e', status: 'completed', conclusion: 'failure', steps: [{ name: 'Run playwright', status: 'completed', conclusion: 'failure' }] }] })
  expect([failed.status, failed.failures]).toEqual(['failed', ['e2e › Run playwright']])
})

test('git push output: the GitHub repo, the branch and the new commit', async () => {
  expect(pushedTo('To https://github.com/acme/web.git\n   376ec5f..6fb617a  main -> main\n')).toEqual({ repo: 'acme/web', dst: 'main', sha: '6fb617a' })
  expect(pushedTo('To github.com:acme/web.git\n * [new branch]      feat/x -> feat/x\n')).toEqual({ repo: 'acme/web', dst: 'feat/x', sha: undefined })
  expect(pushedTo('To git@github.com:acme/web.git\n + 1a2b3c4...5d6e7f8 main -> main (forced update)\n')).toEqual({ repo: 'acme/web', dst: 'main', sha: '5d6e7f8' })
  expect(pushedTo('To https://gitlab.com/acme/web.git\n   1a2b3c4..5d6e7f8  main -> main\n').repo).toBe(undefined)
  expect(pushedTo('Everything up-to-date\n').dst).toBe(undefined)
})

test('runs found after a push: the pushed commit only, not ones already tracked', async () => {
  const rows = [
    { databaseId: 1, headSha: '6fb617a0000', createdAt: '2026-11-20T10:00:05Z' },
    { databaseId: 2, headSha: '1111111aaaa', createdAt: '2026-11-20T10:00:06Z' },
    { databaseId: 3, headSha: '6fb617a0000', createdAt: '2026-11-20T10:00:07Z' },
  ]
  expect(newRuns(rows, new Set(['gh:3']), { sha: '6fb617a' }).map(r => r.databaseId)).toEqual([1])
  const since = Date.parse('2026-11-20T10:05:00Z')
  expect(newRuns(rows, new Set(), { since }).map(r => r.databaseId)).toEqual([])
})

const run = (p: Partial<Run>): Run => ({
  id: 'x',
  kind: 'gh',
  label: 'x',
  status: 'passed',
  done: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  failures: [],
  tail: [],
  carry: '',
  offset: 0,
  startedAt: 0,
  lastOutputAt: 0,
  lastChangeAt: 0,
  stallMs: 1,
  isAlerted: false,
  wakeOnFinish: true,
  ...p,
})

test('one message per push, once all its workflows have ended', async () => {
  const a = run({ id: 'gh:1', group: 'push:abc' })
  const b = run({ id: 'gh:2', group: 'push:abc', status: 'running' })
  expect(finishedToReport([a, b])).toEqual([])
  const b2 = { ...b, status: 'failed' as const }
  expect(finishedToReport([a, b2]).map(g => g.map(r => r.id))).toEqual([['gh:1', 'gh:2']])
  expect(finishedToReport([{ ...a, isReported: true }, { ...b2, isReported: true }])).toEqual([])
  expect(finishedToReport([run({ id: 'gh:9' })]).map(g => g.map(r => r.id))).toEqual([['gh:9']])
  expect(finishedToReport([run({ id: 'log:1', kind: 'log', wakeOnFinish: false })])).toEqual([])
})
