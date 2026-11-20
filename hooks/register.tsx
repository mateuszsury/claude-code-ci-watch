import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, Run, RunStatus, TurnState } from '../types'
import {
  emptyTally,
  feed,
  flush,
  ghRunOf,
  isTestCommand,
  isWaitCommand,
  labelOf,
  outputPathOf,
  taskEndOf,
  taskIdOf,
} from './parse'

type $T = EngineInterface

const PANE = 'ci-watch'
const TITLE = 'Tests & CI'
const TICK_MS = 2000
const GH_POLL_MS = 15000
const LOG_STALL_MS = 5 * 60_000
const GH_STALL_MS = 20 * 60_000
const QUEUE_STALL_MS = 10 * 60_000
const KEEP_FINISHED = 8
const READ_MAX = 1 << 20

// Change the tag when Run's fields change: it declines what an older version stored.
const runsAtom = atom({ plugin: 'ci-watch', key: 'runs' } as const, [] as Run[], {
  shape: 'runs-1',
})
const nowAtom = atom({ plugin: 'ci-watch', key: 'now' } as const, 0)
const turnAtom = atom({ plugin: 'ci-watch', key: 'turn' } as const, {
  isBusy: false,
} as TurnState)

const isActive = (r: Run) =>
  r.status === 'running' || r.status === 'queued' || r.status === 'stalled'

// ---------- formatting ----------

function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function etaOf(r: Run, now: number) {
  if (!isActive(r) || !r.total || !r.firstProgressAt || r.done < 3) return undefined
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

const fraction = (r: Run) =>
  r.total ? `${r.done}/${r.total}` : r.done > 0 ? `${r.done}` : '—'

function oneLine(r: Run) {
  const what = r.current ?? r.tail[r.tail.length - 1] ?? r.label
  const bad = r.failed > 0 ? ` ✗${r.failed}` : ''
  return `${fraction(r)}${bad} · ${what}`
}

// ---------- the runs ----------

function newRun(now: number, p: Partial<Run> & Pick<Run, 'id' | 'kind' | 'label'>): Run {
  return {
    ...emptyTally(),
    status: 'running',
    offset: 0,
    startedAt: now,
    lastOutputAt: now,
    lastChangeAt: now,
    stallMs: p.kind === 'gh' ? GH_STALL_MS : LOG_STALL_MS,
    isAlerted: false,
    wakeOnFinish: p.kind === 'gh',
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
  const lines = [`- ${r.label} [${r.kind === 'gh' ? `GitHub run ${r.ghRunId}` : r.taskId ? `task ${r.taskId}` : r.kind}]: ${WORD[r.status]}, ${clock((r.endedAt ?? now) - r.startedAt)}`]
  if (r.kind === 'gh' && r.jobs) {
    for (const j of r.jobs) {
      lines.push(`  • ${j.name}: ${j.conclusion || j.status}${j.step ? ` (step ${j.stepsDone}/${j.stepsTotal}: ${j.step})` : ''}`)
    }
    if (r.url) lines.push(`  ${r.url}`)
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
  const quiet = clock(now - (r.kind === 'gh' ? r.lastChangeAt : r.lastOutputAt))
  const head =
    r.status === 'queued'
      ? `[ci-watch] GitHub run ${r.ghRunId} has been queued for ${quiet}: probably no runner is available or the workflow is blocked.`
      : r.kind === 'gh'
        ? `[ci-watch] GitHub run ${r.ghRunId} has not changed for ${quiet}: it looks stuck.`
        : `[ci-watch] Tests "${r.label}" have printed nothing for ${quiet}: they look stuck.`
  return `${head}\n${describe(r, now)}\nDo not keep waiting idly: find the cause (log, process, runner), then stop and rerun it or fix it. Tell the user what you did.`
}

function finishText(r: Run, now: number) {
  const verdict = r.status === 'passed' ? '✅ passed' : r.status === 'cancelled' ? '■ cancelled' : '❌ failed'
  return `[ci-watch] GitHub run ${r.ghRunId} finished: ${verdict}.\n${describe(r, now)}\nContinue the task based on this result.`
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

type GhStep = { name: string; status: string; conclusion: string | null }
type GhJob = { name: string; status: string; conclusion: string | null; steps?: GhStep[] }
type GhRun = {
  status: string
  conclusion: string | null
  displayTitle?: string
  workflowName?: string
  url?: string
  jobs?: GhJob[]
}

const BAD = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

async function pollGh($: $T, r: Run, now: number): Promise<Run> {
  if (!r.ghRunId) return r
  const argv = ['gh', 'run', 'view', r.ghRunId, '--json', 'status,conclusion,displayTitle,workflowName,jobs,url']
  if (r.repo) argv.push('-R', r.repo)
  const res = await $.process
    .run(argv, { timeoutMs: 20_000, ...(r.cwd && !r.repo ? { cwd: r.cwd } : {}) })
    .catch(() => undefined)
  if (!res || res.exitCode !== 0) {
    const why = res ? (res.stderr || res.stdout).trim().split('\n')[0] : 'gh did not start'
    return { ...r, tail: [`gh: ${why}`] }
  }
  let run: GhRun
  try {
    run = JSON.parse(res.stdout) as GhRun
  } catch {
    return r
  }
  const jobs: Job[] = (run.jobs ?? []).map(j => {
    const steps = j.steps ?? []
    const doneSteps = steps.filter(s => s.status === 'completed').length
    const live = steps.find(s => s.status === 'in_progress') ?? steps.find(s => s.conclusion && BAD.has(s.conclusion))
    return {
      name: j.name,
      status: j.status,
      conclusion: j.conclusion ?? '',
      step: live?.name,
      stepsDone: doneSteps,
      stepsTotal: steps.length,
    }
  })
  const signature = JSON.stringify(jobs.map(j => [j.status, j.conclusion, j.stepsDone]))
  const before = JSON.stringify((r.jobs ?? []).map(j => [j.status, j.conclusion, j.stepsDone]))
  const progressed = signature !== before
  const isDone = run.status === 'completed'
  const status: RunStatus = isDone
    ? run.conclusion === 'cancelled'
      ? 'cancelled'
      : run.conclusion && BAD.has(run.conclusion)
        ? 'failed'
        : 'passed'
    : ['queued', 'waiting', 'pending', 'requested'].includes(run.status)
      ? 'queued'
      : r.status === 'stalled' && !progressed
        ? 'stalled'
        : 'running'
  const liveJob = jobs.find(j => j.status === 'in_progress')
  const failedJobs = jobs.filter(j => BAD.has(j.conclusion))
  const title = [run.workflowName, run.displayTitle].filter(Boolean).join(' · ')
  return {
    ...r,
    label: title ? (title.length > 70 ? title.slice(0, 69) + '…' : title) : r.label,
    url: run.url ?? r.url,
    jobs,
    status,
    done: jobs.reduce((n, j) => n + j.stepsDone, 0),
    total: jobs.reduce((n, j) => n + j.stepsTotal, 0) || undefined,
    passed: jobs.filter(j => j.conclusion === 'success').length,
    failed: failedJobs.length,
    skipped: jobs.filter(j => j.conclusion === 'skipped' || j.conclusion === 'cancelled').length,
    current: liveJob ? `${liveJob.name} › ${liveJob.step ?? '…'}` : undefined,
    failures: failedJobs.map(j => (j.step ? `${j.name} › ${j.step}` : j.name)),
    tail: [],
    lastChangeAt: progressed ? now : r.lastChangeAt,
    lastOutputAt: now,
    firstProgressAt: r.firstProgressAt ?? (status === 'running' ? now : undefined),
    endedAt: isDone ? (r.endedAt ?? now) : undefined,
    isAlerted: progressed ? false : r.isAlerted,
  }
}

type Alert = { kind: 'stall' | 'finish'; run: Run }

function checkStall(r: Run, now: number, alerts: Alert[]): Run {
  if (!isActive(r) || r.isAlerted || r.kind === 'fg') return r
  const quiet = now - (r.kind === 'gh' ? r.lastChangeAt : r.lastOutputAt)
  const limit = r.status === 'queued' ? QUEUE_STALL_MS : r.stallMs
  if (quiet < limit) return r
  const next: Run = { ...r, status: r.status === 'queued' ? 'queued' : 'stalled', isAlerted: true }
  alerts.push({ kind: 'stall', run: next })
  return next
}

const ghPolledAt = new Map<string, number>()
let isTicking = false

async function tick($: $T) {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    const runs = await read($, runsAtom)
    const active = runs.filter(isActive)
    if (active.length === 0) {
      $.ui.status(undefined)
      return
    }
    const alerts: Alert[] = []
    const changed = new Map<string, Run>()
    for (const r of active) {
      let n = r
      if (r.kind === 'log') n = await pollLog($, r, now)
      else if (r.kind === 'gh' && now - (ghPolledAt.get(r.id) ?? 0) >= GH_POLL_MS) {
        ghPolledAt.set(r.id, now)
        n = await pollGh($, r, now)
        if (!isActive(n) && n.wakeOnFinish) alerts.push({ kind: 'finish', run: n })
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
    await update($, nowAtom, () => now)

    const lead = [...changed.values(), ...active].find(isActive)
    $.ui.status(lead ? `🧪 ${oneLine(lead)}` : undefined)

    for (const a of alerts) {
      if (a.kind === 'stall') {
        $.ui.toast(`⏸ Stalled: ${a.run.label}`)
        void $.ui.notify(`No progress: ${a.run.label}`, { title: 'CI / tests' })
        await tellAgent($, stallText(a.run, now), true)
      } else {
        const ok = a.run.status === 'passed'
        $.ui.toast(`${ok ? '✓' : '✗'} CI: ${a.run.label}`)
        void $.ui.notify(`${ok ? 'Passed' : 'Failed'}: ${a.run.label}`, { title: 'CI' })
        await tellAgent($, finishText(a.run, now), true)
      }
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

async function trackGh($: $T, runId: string, extra: Partial<Run>) {
  const now = await $.clock.now()
  const runs = await read($, runsAtom)
  const id = `gh:${runId}`
  const known = runs.find(r => r.id === id)
  if (known && isActive(known)) return known
  ghPolledAt.delete(id)
  const run = newRun(now, { id, kind: 'gh', label: `GitHub run ${runId}`, ghRunId: runId, ...extra })
  await addRun($, run)
  return run
}

async function trackLog($: $T, path: string, extra: Partial<Run>) {
  const now = await $.clock.now()
  const id = `log:${extra.taskId ?? path}`
  const run = newRun(now, { id, kind: 'log', label: path.split(/[\\/]/).pop() ?? path, path, ...extra })
  await addRun($, run)
  return run
}

// ---------- the module ----------

const STATUS_TOOL = 'mcp__ci-watch__status'
const TRACK_TOOL = 'mcp__ci-watch__track'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci',
      description: 'Tests & CI panel. /ci opens it; /ci <run id | run URL | log path> tracks a run; /ci clear removes finished runs',
      argumentHint: '[run-id | url | log | clear]',
    })
    await $.tool.register({
      name: 'status',
      description:
        'Live state of every test/CI run the ci-watch panel tracks: done/total, the current test, failures, silence time, stalls, and GitHub Actions jobs with their current step. Call this instead of sleeping, polling log files or re-running `gh run view` while tests or CI run.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'track',
      description:
        "Start tracking a run in the ci-watch panel: a GitHub Actions run (gh_run_id, optional repo 'owner/name') or a log file a test command writes (log_path). The panel shows live progress and wakes you if it stalls for stall_minutes, and for GitHub runs when they finish. Background Bash test commands and `gh run watch <id>` are tracked automatically.",
      inputSchema: {
        type: 'object',
        properties: {
          gh_run_id: { type: 'string' },
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

  // Test commands the agent runs, in the foreground or the background.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool !== 'Bash' && tool !== 'PowerShell') return next(e)
    const input = e as unknown as { command?: unknown; run_in_background?: unknown }
    const command = typeof input.command === 'string' ? input.command : ''
    const isBackground = input.run_in_background === true
    const isTest = isTestCommand(command)
    const gh = ghRunOf(command)
    if (gh) await trackGh($, gh.runId, { repo: gh.repo, cwd: cwdOf(command) })

    const fgId = `fg:${e.tool_use_id}`
    if (isTest && !isBackground) {
      await addRun($, newRun(await $.clock.now(), { id: fgId, kind: 'fg', label: labelOf(command) }))
    }
    if (!isBackground && isWaitCommand(command)) waits.add(e.tool_use_id)
    let res
    try {
      res = await next(e)
    } finally {
      waits.delete(e.tool_use_id)
    }
    if (!isTest) return res

    const result = (res.result ?? {}) as {
      stdout?: string
      stderr?: string
      interrupted?: boolean
      backgroundTaskId?: string
      backgroundOutputPath?: string
    }
    const text = res.text ?? ''
    const taskId = result.backgroundTaskId ?? taskIdOf(text)
    const path = outputPathOf(text) ?? result.backgroundOutputPath
    if (taskId && path) {
      // Started in the background, or moved there after its timeout.
      await update($, runsAtom, list => list.filter(r => r.id !== fgId))
      await trackLog($, path, { taskId, label: labelOf(command) })
      return res
    }
    if (!isBackground) {
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
      repo?: string
      log_path?: string
      label?: string
      stall_minutes?: number
      notify_on_finish?: boolean
    }
    const extra: Partial<Run> = {}
    if (a.label) extra.label = a.label
    if (a.stall_minutes && a.stall_minutes > 0) extra.stallMs = a.stall_minutes * 60_000
    if (a.notify_on_finish !== undefined) extra.wakeOnFinish = a.notify_on_finish
    if (a.gh_run_id) {
      const run = await trackGh($, String(a.gh_run_id).replace(/\D/g, ''), { repo: a.repo, ...extra })
      return { result: `ci-watch: tracking ${run.label}. You will be woken if it stalls${run.wakeOnFinish ? ' and when it finishes' : ''}.` }
    }
    if (a.log_path) {
      const run = await trackLog($, a.log_path, extra)
      return { result: `ci-watch: tracking the log ${run.path}.` }
    }
    return { result: 'ci-watch: pass gh_run_id or log_path.' }
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

    const bar = (r: Run) => (
      <Progress
        label={r.current ?? r.label}
        value={isActive(r) ? (r.total ? r.done : undefined) : (r.total ?? 1)}
        max={r.total ?? 1}
        valueText={fraction(r)}
        color={COLOR[r.status]}
      />
    )

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
              {r.framework ? <Text dimColor> · {r.framework}</Text> : null}
              {r.kind === 'gh' ? <Text dimColor> · GitHub Actions</Text> : null}
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

          {r.kind === 'gh' && r.jobs ? (
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
                    <Text dimColor tabular>
                      {j.stepsDone}/{j.stepsTotal}
                    </Text>
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

          {r.current && isActive(r) && r.kind !== 'gh' ? (
            <Text mono dimColor wrap="truncate-middle">
              ▸ {r.current}
            </Text>
          ) : null}

          {!r.framework && r.kind !== 'gh' && r.tail.length > 0 ? (
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
              Background test commands and `gh run watch` show up here by themselves. By hand: /ci &lt;run id | log path&gt;.
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
