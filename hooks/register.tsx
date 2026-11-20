import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, RunStatus, TurnState } from '../types'
import { BAD, checksSnapshot, finishedToReport, newRuns, pushedTo, runSnapshot } from './github'
import type { GhCheck, GhRun, GhRunRow, Snapshot } from './github'
import {
  emptyTally,
  feed,
  flush,
  ghRunOf,
  classify,
  isWaitCommand,
  labelOf,
  outputPathOf,
  prChecksOf,
  prMergeOf,
  pushOf,
  taskEndOf,
  taskIdOf,
  workflowRunOf,
} from './parse'

type $T = EngineInterface

const PANE = 'ci-watch'
const TITLE = 'Tests & CI'
const TICK_MS = 2000
const GH_POLL_MS = 15000
const KEEP_FINISHED = 8
const READ_MAX = 1 << 20
/** When to look for the runs a push, merge or dispatch started: they appear after a few seconds. */
const LOOKUP_DELAYS = [5, 12, 25, 45, 80, 140].map(s => s * 1000)
/** A foreground command gets a card after this long; quicker ones never show. */
const FG_CARD_DELAY_MS = 10_000
const RUN_FIELDS = 'databaseId,workflowName,displayTitle,status,createdAt,headSha,event,url'

// ---------- options ----------

type Config = {
  testStallMs: number
  buildStallMs: number
  deployStallMs: number
  ciStallMs: number
  queueStallMs: number
  autoTrackGitHub: boolean
  wakeOnCiFinish: boolean
}

const minutes = (v: unknown, fallback: number) => {
  const n = typeof v === 'number' ? v : Number(v)
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60_000
}

let cfg: Config = {
  testStallMs: 5 * 60_000,
  buildStallMs: 10 * 60_000,
  deployStallMs: 20 * 60_000,
  ciStallMs: 20 * 60_000,
  queueStallMs: 10 * 60_000,
  autoTrackGitHub: true,
  wakeOnCiFinish: true,
}

// ---------- state ----------

// Change the tag when Run's fields change incompatibly: it declines what an older version stored.
const runsAtom = atom({ plugin: 'ci-watch', key: 'runs' } as const, [] as Run[], {
  shape: 'runs-1',
})
const nowAtom = atom({ plugin: 'ci-watch', key: 'now' } as const, 0)
const turnAtom = atom({ plugin: 'ci-watch', key: 'turn' } as const, {
  isBusy: false,
} as TurnState)

const isActive = (r: Run) =>
  r.status === 'running' || r.status === 'queued' || r.status === 'stalled'
const isRemote = (r: Run) => r.kind === 'gh' || r.kind === 'pr'

// ---------- formatting ----------

function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function etaOf(r: Run, now: number) {
  if (!isActive(r) || !r.total || !r.firstProgressAt || r.done < 3 || isRemote(r)) return undefined
  const rate = r.done / Math.max(1, now - r.firstProgressAt)
  const left = (r.total - r.done) / rate
  return left > 0 && Number.isFinite(left) ? clock(left) : undefined
}

const COLOR: Record<RunStatus, string> = {
  running: 'claude',
  queued: 'subtle',
  stalled: 'warning',
  passed: 'success',
  failed: 'error',
  cancelled: 'inactive',
}
const ICON: Record<RunStatus, string> = {
  running: '●',
  queued: '◌',
  stalled: '⏸',
  passed: '✓',
  failed: '✗',
  cancelled: '■',
}
const WORD: Record<RunStatus, string> = {
  running: 'Running',
  queued: 'Queued',
  stalled: 'Stalled',
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const kindLabel = (r: Run) =>
  r.kind === 'gh'
    ? 'GitHub Actions'
    : r.kind === 'pr'
      ? 'PR checks'
      : r.category === 'deploy'
        ? 'deploy'
        : r.category === 'build'
          ? r.framework && r.framework !== 'steps' ? `build · ${r.framework}` : 'build'
          : r.framework

/** How far a run is, in percent: from its n/m count, else from the last percentage it printed. */
function percentOf(r: Run): number | undefined {
  if (r.total) return Math.min(100, Math.floor((r.done / r.total) * 100))
  return r.percent === undefined ? undefined : Math.floor(r.percent)
}

const fraction = (r: Run) => {
  const pct = percentOf(r)
  const count = r.total ? `${r.done}/${r.total}` : r.done > 0 ? `${r.done}` : ''
  return [count, pct === undefined ? '' : `${pct}%`].filter(Boolean).join(' · ') || '—'
}

const ICON_OF_KIND = (r: Run) =>
  r.kind === 'gh' || r.kind === 'pr' ? '⚙' : r.category === 'deploy' ? '🚀' : r.category === 'build' ? '🔨' : '🧪'

function oneLine(r: Run) {
  const what = r.current ?? r.tail[r.tail.length - 1] ?? r.label
  const bad = r.failed > 0 ? ` ✗${r.failed}` : ''
  return `${fraction(r)}${bad} · ${what}`
}

const short = (s: string) => (s.length > 70 ? s.slice(0, 69) + '…' : s)

// ---------- the runs ----------

function newRun(now: number, p: Partial<Run> & Pick<Run, 'id' | 'kind' | 'label'>): Run {
  const remote = p.kind === 'gh' || p.kind === 'pr'
  return {
    ...emptyTally(),
    status: 'running',
    offset: 0,
    startedAt: now,
    lastOutputAt: now,
    lastChangeAt: now,
    stallMs: remote
      ? cfg.ciStallMs
      : p.category === 'deploy'
        ? cfg.deployStallMs
        : p.category === 'build'
          ? cfg.buildStallMs
          : cfg.testStallMs,
    isAlerted: false,
    wakeOnFinish: remote && cfg.wakeOnCiFinish,
    ...p,
  }
}

function prune(list: Run[]) {
  const finished = list.filter(r => !isActive(r))
  if (finished.length <= KEEP_FINISHED) return list
  const drop = new Set(
    finished
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
      .slice(0, finished.length - KEEP_FINISHED)
      .map(r => r.id),
  )
  return list.filter(r => !drop.has(r.id))
}

async function addRun($: $T, run: Run) {
  let isNew = false
  await update($, runsAtom, list => {
    const i = list.findIndex(r => r.id === run.id)
    isNew = i < 0
    return i < 0 ? prune([...list, run]) : list.map((r, k) => (k === i ? { ...r, ...run, startedAt: r.startedAt } : r))
  })
  if (isNew) void $.ui.open({ id: PANE, title: TITLE })
}

async function patchRun($: $T, id: string, fn: (r: Run) => Run) {
  await update($, runsAtom, list => list.map(r => (r.id === id ? fn(r) : r)))
}

/** Git Bash paths (/d/x) to Windows ones (D:/x) for the host's process.run. */
const nativePath = (p: string) => p.replace(/^\/([a-zA-Z])\//, (_, d: string) => `${d.toUpperCase()}:/`)

function cwdOf(command: string) {
  const m = command.match(/^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/)
  const p = m?.[2] ?? m?.[3] ?? m?.[4]
  return p ? nativePath(p) : undefined
}

const repoArgs = (repo?: string) => (repo ? ['-R', repo] : [])
const runInit = (cwd?: string, repo?: string) => ({ timeoutMs: 20_000, ...(cwd && !repo ? { cwd } : {}) })

// ---------- telling the agent ----------

/** tool_use_ids of foreground commands that only wait (gh run watch, sleep). */
const waits = new Set<string>()

async function tellAgent($: $T, text: string, isUrgent: boolean) {
  try {
    await reachAgent($, text, isUrgent)
  } catch (err) {
    $.ui.toast(`ci-watch: could not notify the agent (${String(err).slice(0, 120)})`)
  }
}

async function reachAgent($: $T, text: string, isUrgent: boolean) {
  const turn = await read($, turnAtom)
  if (!turn.isBusy) {
    await $.prompt.submit({ text })
    return
  }
  if (isUrgent && waits.size > 0 && turn.turnId !== undefined) {
    // The agent is stuck in a blocking wait: end the wait, then tell it.
    await $.turn.abort({ turnId: turn.turnId }).catch(() => undefined)
    await $.prompt.submit({ text })
    return
  }
  await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text }] },
  })
}

function describe(r: Run, now: number) {
  const where =
    r.kind === 'gh' ? `GitHub run ${r.ghRunId}` : r.kind === 'pr' ? `checks of PR ${r.pr ?? '(current branch)'}` : r.taskId ? `task ${r.taskId}` : r.kind
  const lines = [`- ${r.label} [${where}${r.category === 'deploy' ? ', deploy' : ''}]: ${WORD[r.status]}, ${clock((r.endedAt ?? now) - r.startedAt)}`]
  if (isRemote(r)) {
    for (const j of r.jobs ?? []) {
      const state = j.conclusion || j.status
      lines.push(`  • ${j.name}: ${state}${j.step ? ` (step ${j.stepsDone}/${j.stepsTotal}: ${j.step})` : ''}`)
    }
    if (r.url) lines.push(`  ${r.url}`)
    if (r.tail.length) lines.push(`  ${r.tail[r.tail.length - 1]}`)
  } else {
    lines.push(`  progress ${fraction(r)}${r.framework ? ` (${r.framework})` : ''}; ✓${r.passed} ✗${r.failed} ○${r.skipped}`)
    if (r.current) lines.push(`  now: ${r.current}`)
    if (r.failures.length) lines.push(`  failed: ${r.failures.slice(-10).join('; ')}`)
    if (isActive(r)) lines.push(`  silent for ${clock(now - r.lastOutputAt)}`)
    if (r.path) lines.push(`  log: ${r.path}`)
    if (!r.framework && r.tail.length) lines.push(`  last line: ${r.tail[r.tail.length - 1]}`)
  }
  return lines.join('\n')
}

function stallText(r: Run, now: number) {
  const quiet = clock(now - (isRemote(r) ? r.lastChangeAt : r.lastOutputAt))
  const what =
    r.kind === 'gh'
      ? `GitHub run ${r.ghRunId}`
      : r.kind === 'pr'
        ? `The checks of PR ${r.pr ?? '(current branch)'}`
        : r.category === 'deploy'
          ? `Deploy "${r.label}"`
          : `Tests "${r.label}"`
  const head =
    r.status === 'queued'
      ? `[ci-watch] ${what} has been queued for ${quiet}: probably no runner is available or the workflow is blocked.`
      : isRemote(r)
        ? `[ci-watch] ${what} has not changed for ${quiet}: it looks stuck.`
        : `[ci-watch] ${what} has printed nothing for ${quiet}: it looks stuck.`
  return `${head}\n${describe(r, now)}\nDo not keep waiting idly: find the cause (log, process, runner), then stop and rerun it or fix it. Tell the user what you did.`
}

function finishText(runs: Run[], now: number) {
  const failed = runs.filter(r => r.status === 'failed').length
  const cancelled = runs.filter(r => r.status === 'cancelled').length
  const verdict =
    failed > 0
      ? `❌ ${failed} of ${runs.length} failed`
      : cancelled > 0
        ? `■ ${cancelled} of ${runs.length} cancelled`
        : runs.length > 1
          ? `✅ all ${runs.length} passed`
          : '✅ passed'
  const first = runs[0]!
  const group = first.group ?? ''
  const what = group.startsWith('push:')
    ? `GitHub Actions for the push of ${group.split(':').pop()}`
    : group.startsWith('merge:')
      ? `GitHub Actions for the merge commit ${group.split(':').pop()}`
      : group.startsWith('dispatch:')
        ? `The dispatched workflow ${group.split(':')[1]}`
        : first.kind === 'pr'
          ? `The checks of PR ${first.pr ?? '(current branch)'}`
          : `GitHub run ${first.ghRunId}`
  return `[ci-watch] ${what} finished: ${verdict}.\n${runs.map(r => describe(r, now)).join('\n')}\nContinue the task based on this result.`
}

// ---------- polling ----------

async function pollLog($: $T, r: Run, now: number): Promise<Run> {
  if (!r.path) return r
  const st = await $.fs.stat(r.path).catch(() => undefined)
  if (!st) return r
  const from = st.size < r.offset ? 0 : r.offset
  if (st.size === from) return r
  const length = Math.min(st.size - from, READ_MAX)
  const chunk = await $.fs.read(r.path, { offset: from, length }).catch(() => undefined)
  if (typeof chunk !== 'string') return r
  const t = feed(from === 0 && r.offset > 0 ? { ...r, ...emptyTally() } : r, chunk)
  const progressed = t.done !== r.done || t.current !== r.current || t.total !== r.total
  return {
    ...r,
    ...t,
    offset: from + length,
    lastOutputAt: now,
    lastChangeAt: progressed ? now : r.lastChangeAt,
    firstProgressAt: r.firstProgressAt ?? (t.done > 0 ? now : undefined),
    status: r.status === 'stalled' ? 'running' : r.status,
    isAlerted: false,
  }
}

function applySnapshot(r: Run, s: Snapshot, now: number, extra: Partial<Run>): Run {
  const progressed = s.signature !== r.signature
  const isDone = s.status === 'passed' || s.status === 'failed' || s.status === 'cancelled'
  const status: RunStatus = isDone
    ? s.status
    : s.status === 'queued'
      ? 'queued'
      : r.status === 'stalled' && !progressed
        ? 'stalled'
        : 'running'
  return {
    ...r,
    ...extra,
    jobs: s.jobs,
    status,
    done: s.done,
    total: s.total,
    passed: s.passed,
    failed: s.failed,
    skipped: s.skipped,
    current: s.current,
    failures: s.failures,
    signature: s.signature,
    tail: [],
    lastChangeAt: progressed ? now : r.lastChangeAt,
    lastOutputAt: now,
    firstProgressAt: r.firstProgressAt ?? (status === 'running' ? now : undefined),
    endedAt: isDone ? (r.endedAt ?? now) : undefined,
    isAlerted: progressed ? false : r.isAlerted,
  }
}

const ghError = (res: { stderr: string; stdout: string } | undefined) =>
  res ? ((res.stderr || res.stdout).trim().split('\n')[0] ?? '') : 'gh did not start'

async function pollGh($: $T, r: Run, now: number): Promise<Run> {
  if (!r.ghRunId) return r
  const res = await $.process
    .run(['gh', 'run', 'view', r.ghRunId, '--json', 'status,conclusion,displayTitle,workflowName,jobs,url', ...repoArgs(r.repo)], runInit(r.cwd, r.repo))
    .catch(() => undefined)
  if (!res || res.exitCode !== 0) return { ...r, tail: [`gh: ${ghError(res)}`] }
  let run: GhRun
  try {
    run = JSON.parse(res.stdout) as GhRun
  } catch {
    return r
  }
  const title = [run.workflowName, run.displayTitle].filter(Boolean).join(' · ')
  return applySnapshot(r, runSnapshot(run), now, { label: title ? short(title) : r.label, url: run.url ?? r.url })
}

async function pollPr($: $T, r: Run, now: number): Promise<Run> {
  const res = await $.process
    .run(['gh', 'pr', 'checks', ...(r.pr ? [r.pr] : []), '--json', 'name,state,bucket,workflow,link', ...repoArgs(r.repo)], runInit(r.cwd, r.repo))
    .catch(() => undefined)
  // Exit code 8: checks are pending. "no checks reported": none yet.
  const isNone = res !== undefined && /no checks reported/i.test(res.stderr + res.stdout)
  if (!res || (res.exitCode !== 0 && res.exitCode !== 8 && !isNone)) return { ...r, tail: [`gh: ${ghError(res)}`] }
  let checks: GhCheck[] = []
  if (!isNone && res.stdout.trim() !== '') {
    try {
      checks = JSON.parse(res.stdout) as GhCheck[]
    } catch {
      return r
    }
  }
  return applySnapshot(r, checksSnapshot(checks), now, {})
}

type Alert = { run: Run }

function checkStall(r: Run, now: number, alerts: Alert[]): Run {
  if (!isActive(r) || r.isAlerted || r.kind === 'fg') return r
  const quiet = now - (isRemote(r) ? r.lastChangeAt : r.lastOutputAt)
  const limit = r.status === 'queued' ? cfg.queueStallMs : r.stallMs
  if (quiet < limit) return r
  const next: Run = { ...r, status: r.status === 'queued' ? 'queued' : 'stalled', isAlerted: true }
  alerts.push({ run: next })
  return next
}

const polledAt = new Map<string, number>()
let isTicking = false

async function tick($: $T) {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    const runs = await read($, runsAtom)
    const active = runs.filter(isActive)
    const alerts: Alert[] = []
    const changed = new Map<string, Run>()
    for (const r of active) {
      let n = r
      if (r.kind === 'log') n = await pollLog($, r, now)
      else if (isRemote(r) && now - (polledAt.get(r.id) ?? 0) >= GH_POLL_MS) {
        polledAt.set(r.id, now)
        n = r.kind === 'gh' ? await pollGh($, r, now) : await pollPr($, r, now)
      }
      n = checkStall(n, now, alerts)
      if (n !== r) changed.set(r.id, n)
    }
    if (changed.size > 0) {
      await update($, runsAtom, list =>
        // A run another hook finished meanwhile keeps its ending.
        list.map(x => (changed.has(x.id) && isActive(x) ? changed.get(x.id)! : x)),
      )
    }
    if (active.length > 0) await update($, nowAtom, () => now)

    const list = await read($, runsAtom)
    const lead = list.find(isActive)
    $.ui.status(lead ? `${ICON_OF_KIND(lead)} ${oneLine(lead)}` : undefined)

    const reports = finishedToReport(list)
    if (reports.length > 0) {
      const ids = new Set(reports.flat().map(r => r.id))
      await update($, runsAtom, l => l.map(r => (ids.has(r.id) ? { ...r, isReported: true } : r)))
    }

    for (const a of alerts) {
      $.ui.toast(`⏸ Stalled: ${a.run.label}`)
      void $.ui.notify(`No progress: ${a.run.label}`, { title: 'CI / tests' })
      await tellAgent($, stallText(a.run, now), true)
    }
    for (const group of reports) {
      const ok = group.every(r => r.status === 'passed')
      const name = group.length > 1 ? `${group.length} workflows` : group[0]!.label
      $.ui.toast(`${ok ? '✓' : '✗'} CI: ${name}`)
      void $.ui.notify(`${ok ? 'Passed' : 'Failed'}: ${name}`, { title: 'CI' })
      await tellAgent($, finishText(group, now), true)
    }
  } finally {
    isTicking = false
  }
}

async function finishTask($: $T, end: { taskId: string; status: string; exitCode?: number }) {
  const runs = await read($, runsAtom)
  const r = runs.find(x => x.taskId === end.taskId && isActive(x))
  if (!r) return
  const now = await $.clock.now()
  const last = flush(await pollLog($, r, now))
  const status: RunStatus =
    end.status === 'completed' && (end.exitCode === undefined || end.exitCode === 0)
      ? last.failed > 0
        ? 'failed' // `|| true` or a wrapper swallowed the exit code
        : 'passed'
      : end.status === 'killed' || end.status === 'stopped' || end.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
  await patchRun($, r.id, x => ({ ...x, ...last, status, exitCode: end.exitCode, endedAt: now }))
}

// ---------- starting to track ----------

async function trackGh($: $T, runId: string, extra: Partial<Run>) {
  const now = await $.clock.now()
  const runs = await read($, runsAtom)
  const id = `gh:${runId}`
  const known = runs.find(r => r.id === id)
  if (known && isActive(known)) return known
  polledAt.delete(id)
  const run = newRun(now, { id, kind: 'gh', label: `GitHub run ${runId}`, ghRunId: runId, ...extra })
  await addRun($, run)
  return run
}

async function trackPr($: $T, pr: string | undefined, extra: Partial<Run>) {
  const now = await $.clock.now()
  const id = `pr:${extra.repo ?? extra.cwd ?? ''}:${pr ?? 'current'}`
  const known = (await read($, runsAtom)).find(r => r.id === id)
  if (known && isActive(known)) return known
  polledAt.delete(id)
  const run = newRun(now, { id, kind: 'pr', label: pr ? `PR ${pr}` : 'PR of the current branch', pr, ...extra })
  await addRun($, run)
  // Name the card after the PR, best effort.
  void $.process
    .run(['gh', 'pr', 'view', ...(pr ? [pr] : []), '--json', 'number,title,url', ...repoArgs(extra.repo)], runInit(extra.cwd, extra.repo))
    .then(async res => {
      if (res.exitCode !== 0) return
      const v = JSON.parse(res.stdout) as { number: number; title: string; url: string }
      await patchRun($, id, r => ({ ...r, label: short(`PR #${v.number} · ${v.title}`), url: v.url }))
    })
    .catch(() => undefined)
  return run
}

async function trackLog($: $T, path: string, extra: Partial<Run>) {
  const now = await $.clock.now()
  const id = `log:${extra.taskId ?? path}`
  const run = newRun(now, { id, kind: 'log', label: path.split(/[\\/]/).pop() ?? path, path, ...extra })
  await addRun($, run)
  return run
}

type Lookup = {
  /** `gh run list` filters: `--commit`, `--branch`, `--workflow`, `--event`. */
  filters: string[]
  repo?: string
  cwd?: string
  group: string
  /** Keep only runs created after this time. */
  since?: number
  /** Keep only runs whose head commit starts with this. */
  sha?: string
}

/** Looks for the runs a push, merge or dispatch started, a few times while they appear. */
function scheduleLookup($: $T, l: Lookup) {
  for (const delay of LOOKUP_DELAYS) $.clock.after(delay, () => void lookupRuns($, l))
}

async function lookupRuns($: $T, l: Lookup) {
  const res = await $.process
    .run(['gh', 'run', 'list', ...l.filters, '--limit', '20', '--json', RUN_FIELDS, ...repoArgs(l.repo)], runInit(l.cwd, l.repo))
    .catch(() => undefined)
  if (!res || res.exitCode !== 0) return
  let rows: GhRunRow[]
  try {
    rows = JSON.parse(res.stdout) as GhRunRow[]
  } catch {
    return
  }
  const known = new Set((await read($, runsAtom)).map(r => r.id))
  for (const row of newRuns(rows, known, { since: l.since, sha: l.sha })) {
    const label = [row.workflowName, row.displayTitle].filter(Boolean).join(' · ')
    await trackGh($, String(row.databaseId), {
      repo: l.repo,
      cwd: l.cwd,
      group: l.group,
      url: row.url,
      ...(label ? { label: short(label) } : {}),
    })
  }
}

async function afterPush($: $T, command: string, output: string, now: number) {
  const push = pushOf(command)
  if (!push) return
  const to = pushedTo(output)
  if (!to.repo || !to.dst) return // not GitHub, or nothing went out ("Everything up-to-date")
  const cwd = push.dir ? nativePath(push.dir) : cwdOf(command)
  let sha = to.sha
  if (!sha) {
    // A new branch or tag prints no range: the pushed ref's commit is local.
    const rev = await $.process
      .run(['git', 'rev-parse', `${push.ref ?? 'HEAD'}^{commit}`], { timeoutMs: 10_000, ...(cwd ? { cwd } : {}) })
      .catch(() => undefined)
    if (rev?.exitCode === 0 && /^[0-9a-f]{40}$/.test(rev.stdout.trim())) sha = rev.stdout.trim()
  }
  scheduleLookup($, {
    filters: ['--branch', to.dst],
    repo: to.repo,
    group: `push:${to.repo}:${sha ? sha.slice(0, 7) : to.dst}`,
    since: sha ? undefined : now,
    sha,
  })
}

async function afterMerge($: $T, command: string) {
  const merge = prMergeOf(command)
  if (!merge) return
  const cwd = cwdOf(command)
  const view = await $.process
    .run(['gh', 'pr', 'view', ...(merge.pr ? [merge.pr] : []), '--json', 'mergeCommit,state', ...repoArgs(merge.repo)], runInit(cwd, merge.repo))
    .catch(() => undefined)
  if (!view || view.exitCode !== 0) return
  const v = JSON.parse(view.stdout) as { mergeCommit?: { oid?: string } | null; state?: string }
  const oid = v.mergeCommit?.oid
  if (!oid || v.state !== 'MERGED') return
  scheduleLookup($, { filters: ['--commit', oid], repo: merge.repo, cwd, group: `merge:${oid.slice(0, 7)}` })
}

function afterDispatch($: $T, command: string, now: number) {
  const run = workflowRunOf(command)
  if (!run) return
  scheduleLookup($, {
    filters: ['--workflow', run.workflow, '--event', 'workflow_dispatch', ...(run.ref ? ['--branch', run.ref] : [])],
    repo: run.repo,
    cwd: cwdOf(command),
    group: `dispatch:${run.workflow}:${now}`,
    since: now,
  })
}

// ---------- the module ----------

const STATUS_TOOL = 'mcp__ci-watch__status'
const TRACK_TOOL = 'mcp__ci-watch__track'

export const register: Register = (on, options) => {
  cfg = {
    testStallMs: minutes(options.testStallMinutes, 5),
    buildStallMs: minutes(options.buildStallMinutes, 10),
    deployStallMs: minutes(options.deployStallMinutes, 20),
    ciStallMs: minutes(options.ciStallMinutes, 20),
    queueStallMs: minutes(options.queueStallMinutes, 10),
    autoTrackGitHub: options.autoTrackGitHub !== false,
    wakeOnCiFinish: options.wakeOnCiFinish !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci',
      description:
        'Tests & CI panel. /ci opens it; /ci <run id | run URL | log path> tracks a run; /ci pr [number | URL] tracks PR checks; /ci clear removes finished runs',
      argumentHint: '[run-id | url | log | pr [n] | clear]',
    })
    await $.tool.register({
      name: 'status',
      description:
        'Live state of every test, deploy and CI run the ci-watch panel tracks in this session: done/total, the current test, failures, silence time, stalls, GitHub Actions jobs with their current step, and PR checks. Call this instead of sleeping, polling log files or re-running `gh run view` / `gh pr checks` while tests or CI run.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'track',
      description:
        "Start tracking a run in the ci-watch panel: a GitHub Actions run (gh_run_id), the checks of a pull request (pr: a number, a URL, or 'current'), or a log file a command writes (log_path); repo is 'owner/name'. The panel shows live progress and wakes you if it stalls for stall_minutes, and for GitHub runs and PR checks when they finish. Background test and deploy commands, `gh run watch <id>`, `gh pr checks`, and the runs started by `git push`, `gh pr merge` and `gh workflow run` are tracked automatically.",
      inputSchema: {
        type: 'object',
        properties: {
          gh_run_id: { type: 'string' },
          pr: { type: 'string' },
          repo: { type: 'string', description: 'owner/name' },
          log_path: { type: 'string' },
          label: { type: 'string' },
          stall_minutes: { type: 'number' },
          notify_on_finish: { type: 'boolean' },
        },
      },
      isDeferred: false,
    })
    $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, turnAtom, () => ({ isBusy: true, turnId: e.turnId }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId === undefined) await update($, turnAtom, () => ({ isBusy: false }))
    return res
  })

  // Commands the agent runs: tests and deploys, in the foreground or the background, and git/gh.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool !== 'Bash' && tool !== 'PowerShell') return next(e)
    const input = e as unknown as { command?: unknown; run_in_background?: unknown }
    const command = typeof input.command === 'string' ? input.command : ''
    const isBackground = input.run_in_background === true
    const category = classify(command)
    const cwd = cwdOf(command)

    const gh = ghRunOf(command)
    if (gh) await trackGh($, gh.runId, { repo: gh.repo, cwd })
    const checks = prChecksOf(command)
    if (checks) await trackPr($, checks.pr, { repo: checks.repo, cwd })

    // A foreground command gets a card only once it has run for a while: quick checks stay out of the pane.
    const fgId = `fg:${e.tool_use_id}`
    const startedAt = await $.clock.now()
    let fgAdded: Promise<void> | undefined
    const fgTimer =
      category !== undefined && !isBackground
        ? $.clock.after(FG_CARD_DELAY_MS, () => {
            fgAdded = addRun($, newRun(startedAt, { id: fgId, kind: 'fg', category, label: labelOf(command) }))
          })
        : undefined
    if (!isBackground && isWaitCommand(command)) waits.add(e.tool_use_id)
    let res
    try {
      res = await next(e)
    } finally {
      waits.delete(e.tool_use_id)
      fgTimer?.cancel()
    }
    if (fgAdded) await fgAdded

    const result = (res.result ?? {}) as {
      stdout?: string
      stderr?: string
      interrupted?: boolean
      backgroundTaskId?: string
      backgroundOutputPath?: string
    }
    const text = res.text ?? ''

    if (cfg.autoTrackGitHub && !res.isError && res.deny === undefined && !isBackground) {
      const now = await $.clock.now()
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${text}`
      await afterPush($, command, output, now).catch(() => undefined)
      await afterMerge($, command).catch(() => undefined)
      afterDispatch($, command, now)
    }

    if (category === undefined) return res

    const taskId = result.backgroundTaskId ?? taskIdOf(text)
    const path = outputPathOf(text) ?? result.backgroundOutputPath
    if (taskId && path) {
      // Started in the background, or moved there after its timeout.
      await update($, runsAtom, list => list.filter(r => r.id !== fgId))
      await trackLog($, path, { taskId, category, label: labelOf(command) })
      return res
    }
    if (!isBackground && fgAdded) {
      const now = await $.clock.now()
      const tally = flush(feed(emptyTally(), `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${res.isError ? text : ''}`))
      const exit = Number(text.match(/Exit code (\d+)/)?.[1] ?? (res.isError ? 1 : 0))
      const status: RunStatus = result.interrupted
        ? 'cancelled'
        : res.isError || exit !== 0 || res.deny !== undefined || tally.failed > 0
          ? 'failed'
          : 'passed'
      await patchRun($, fgId, r => ({ ...r, ...tally, status, exitCode: exit, endedAt: now }))
    }
    return res
  })

  // Background commands end with a <task-notification> row.
  on('session.append', async ($, e, next) => {
    const res = await next(e)
    const content = (e.message as { content?: unknown }).content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n')
          : ''
    const end = taskEndOf(text)
    if (end) await finishTask($, end)
    return res
  }).catch(($, e, next) => next(e))

  on('tool.run', { tool: STATUS_TOOL }, async $ => {
    const runs = await read($, runsAtom)
    const now = await $.clock.now()
    if (runs.length === 0) return { result: 'ci-watch: nothing is tracked in this session.' }
    const sorted = [...runs].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.startedAt - a.startedAt)
    return { result: sorted.map(r => describe(r, now)).join('\n') }
  })

  on('tool.run', { tool: TRACK_TOOL }, async ($, e) => {
    const a = e as unknown as {
      gh_run_id?: string
      pr?: string
      repo?: string
      log_path?: string
      label?: string
      stall_minutes?: number
      notify_on_finish?: boolean
    }
    const extra: Partial<Run> = {}
    if (a.label) extra.label = a.label
    if (a.repo) extra.repo = a.repo
    if (a.stall_minutes && a.stall_minutes > 0) extra.stallMs = a.stall_minutes * 60_000
    if (a.notify_on_finish !== undefined) extra.wakeOnFinish = a.notify_on_finish
    if (a.gh_run_id) {
      const run = await trackGh($, String(a.gh_run_id).replace(/\D/g, ''), extra)
      return { result: `ci-watch: tracking ${run.label}. You will be woken if it stalls${run.wakeOnFinish ? ' and when it finishes' : ''}.` }
    }
    if (a.pr) {
      const run = await trackPr($, a.pr === 'current' ? undefined : a.pr, extra)
      return { result: `ci-watch: tracking ${run.label}. You will be woken if the checks stall${run.wakeOnFinish ? ' and when they finish' : ''}.` }
    }
    if (a.log_path) {
      const run = await trackLog($, a.log_path, extra)
      return { result: `ci-watch: tracking the log ${run.path}.` }
    }
    return { result: 'ci-watch: pass gh_run_id, pr or log_path.' }
  })

  on('command.run', { command: 'ci' }, async ($, e) => {
    const arg = String((e as { args?: unknown }).args ?? '').trim()
    if (arg === '') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'Tests & CI panel opened.' }
    }
    if (/^clear$/i.test(arg)) {
      await update($, runsAtom, list => list.filter(isActive))
      return { text: 'Removed finished runs.' }
    }
    const pr = arg.match(/^pr(?:\s+(\S+))?$/i)
    if (pr || /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(arg)) {
      const run = await trackPr($, pr ? pr[1] : arg, {})
      return { text: `Tracking ${run.label}.` }
    }
    const gh = ghRunOf(`gh run view ${arg}`) ?? ghRunOf(arg)
    if (gh) {
      const run = await trackGh($, gh.runId, { repo: gh.repo })
      return { text: `Tracking ${run.label}.` }
    }
    const run = await trackLog($, arg, {})
    return { text: `Tracking the log ${run.path}.` }
  })

  // ---------- drawing ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Progress } = $.ui.resolve(e)
    const runs = await read($, runsAtom)
    const now = Math.max(await read($, nowAtom), ...runs.map(r => r.lastOutputAt))
    const active = runs.filter(isActive).sort((a, b) => b.startedAt - a.startedAt)
    const finished = runs
      .filter(r => !isActive(r))
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))

    const bar = (r: Run) => {
      // A count fills the bar; else a printed percentage; else it runs with no known end.
      const max = r.total ?? (r.percent !== undefined ? 100 : 1)
      const value = !isActive(r) ? max : r.total ? r.done : r.percent
      return <Progress label={r.current ?? r.label} value={value} max={max} valueText={fraction(r)} color={COLOR[r.status]} />
    }

    if (e.props.placement === 'widget') {
      const r = active[0] ?? finished[0]
      if (!r) return <Text dimColor>CI: nothing running</Text>
      return (
        <Box flexDirection="column">
          <Text color={COLOR[r.status]} bold tabular wrap="truncate-end">
            {ICON[r.status]} {fraction(r)}
            {r.failed > 0 ? `  ✗ ${r.failed}` : ''}
            {active.length > 1 ? `  (+${active.length - 1})` : ''}
          </Text>
          <Text dimColor mono wrap="truncate-middle">
            {r.current ?? r.label}
          </Text>
          {bar(r)}
        </Box>
      )
    }

    const card = (r: Run) => {
      const color = COLOR[r.status]
      const eta = etaOf(r, now)
      const quiet = now - r.lastOutputAt
      const shownFailures = r.failures.slice(-5)
      const kind = kindLabel(r)
      return (
        <Box
          key={r.id}
          flexDirection="column"
          borderStyle="round"
          borderColor={color}
          paddingX={1}
          marginBottom={1}
        >
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={color} bold>
              {ICON[r.status]} {WORD[r.status]}
              {kind ? <Text dimColor> · {kind}</Text> : null}
            </Text>
            <Text dimColor tabular>
              {clock((r.endedAt ?? now) - r.startedAt)}
            </Text>
          </Box>
          <Text bold wrap="truncate-end">
            {r.label}
          </Text>

          {r.kind === 'fg' && isActive(r) ? (
            <Text dimColor italic>
              Foreground command: results when it ends (run it in the background to watch it live).
            </Text>
          ) : (
            bar(r)
          )}

          {isRemote(r) && r.jobs ? (
            <Box flexDirection="column">
              {r.jobs.map(j => {
                const st: RunStatus =
                  j.status !== 'completed'
                    ? j.status === 'in_progress'
                      ? 'running'
                      : 'queued'
                    : BAD.has(j.conclusion)
                      ? 'failed'
                      : j.conclusion === 'success'
                        ? 'passed'
                        : 'cancelled'
                return (
                  <Box key={`${r.id}:${j.name}`} flexDirection="row" justifyContent="space-between">
                    <Text color={COLOR[st]} wrap="truncate-end">
                      {ICON[st]} {j.name}
                      {j.step ? <Text dimColor> › {j.step}</Text> : null}
                    </Text>
                    {j.stepsTotal > 0 ? (
                      <Text dimColor tabular>
                        {j.stepsDone}/{j.stepsTotal}
                      </Text>
                    ) : null}
                  </Box>
                )
              })}
            </Box>
          ) : (
            <Box flexDirection="row" gap={2}>
              <Text color="success" tabular>
                ✓ {r.passed}
              </Text>
              <Text color={r.failed > 0 ? 'error' : 'inactive'} tabular>
                ✗ {r.failed}
              </Text>
              <Text dimColor tabular>
                ○ {r.skipped}
              </Text>
              {eta ? (
                <Text dimColor tabular>
                  ETA {eta}
                </Text>
              ) : null}
              {isActive(r) && quiet > 30_000 ? (
                <Text color={r.status === 'stalled' ? 'warning' : 'subtle'} tabular>
                  silent {clock(quiet)}
                </Text>
              ) : null}
            </Box>
          )}

          {r.current && isActive(r) && !isRemote(r) ? (
            <Text mono dimColor wrap="truncate-middle">
              ▸ {r.current}
            </Text>
          ) : null}

          {r.tail.length > 0 && (isRemote(r) || !r.framework) ? (
            <Text mono dimColor wrap="truncate-end">
              {r.tail[r.tail.length - 1]}
            </Text>
          ) : null}

          {shownFailures.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {shownFailures.map(f => (
                <Text color="error" mono wrap="truncate-middle">
                  ✗ {f}
                </Text>
              ))}
              {r.failures.length > shownFailures.length ? (
                <Text dimColor>…and {r.failures.length - shownFailures.length} more</Text>
              ) : null}
            </Box>
          ) : null}

          <Box flexDirection="row" gap={1} marginTop={1}>
            {isActive(r) ? (
              <Button
                key={`${r.id}:tell`}
                label="Notify agent"
                onPress={async () => {
                  const t = await $.clock.now()
                  await tellAgent($, `[ci-watch] The user asks you to look at this run:\n${describe(r, t)}`, true)
                  $.ui.toast('Sent the run state to the agent')
                }}
              />
            ) : null}
            {r.url ? <Link href={r.url} label="Open on GitHub" /> : null}
            <Button
              key={`${r.id}:drop`}
              label={isActive(r) ? 'Stop tracking' : 'Remove'}
              onPress={() => update($, runsAtom, list => list.filter(x => x.id !== r.id))}
            />
          </Box>
        </Box>
      )
    }

    const failedNow = runs.filter(r => r.status === 'failed').length
    const stalledNow = runs.filter(r => r.status === 'stalled').length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text bold size="heading">
            Tests & CI
          </Text>
          <Text dimColor tabular>
            {active.length} running
            {stalledNow > 0 ? <Text color="warning"> · {stalledNow} stalled</Text> : null}
            {failedNow > 0 ? <Text color="error"> · {failedNow} failed</Text> : null}
          </Text>
        </Box>

        {runs.length === 0 ? (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text dimColor>Nothing is running in this session.</Text>
            <Text dimColor>
              Background test and deploy commands, `gh run watch`, `gh pr checks` and the runs a push starts show up here by themselves. By hand: /ci &lt;run id | log path&gt;, /ci pr [number].
            </Text>
          </Box>
        ) : null}

        {active.map(card)}

        {finished.length > 0 ? (
          <Box flexDirection="row" justifyContent="space-between" marginTop={active.length > 0 ? 1 : 0}>
            <Text dimColor bold>
              Finished
            </Text>
            <Button
              key="clear"
              plain
              label="Clear"
              onPress={() => update($, runsAtom, list => list.filter(isActive))}
            />
          </Box>
        ) : null}
        {finished.slice(0, 5).map(card)}
      </Box>
    )
  })
}
