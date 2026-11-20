import type { Job, Run, RunStatus } from '../types'

// What `gh` answers, mapped to what a card shows. Pure: no `$`, so tests feed it
// JSON captured from real `gh` output.

export type GhStep = { name: string; status: string; conclusion: string | null }
export type GhJob = { name: string; status: string; conclusion: string | null; steps?: GhStep[] }
/** `gh run view <id> --json status,conclusion,displayTitle,workflowName,jobs,url` */
export type GhRun = {
  status: string
  conclusion: string | null
  displayTitle?: string
  workflowName?: string
  url?: string
  jobs?: GhJob[]
}
/** One row of `gh run list --json databaseId,workflowName,displayTitle,status,createdAt,headSha,event,url` */
export type GhRunRow = {
  databaseId: number
  workflowName?: string
  displayTitle?: string
  status?: string
  createdAt?: string
  headSha?: string
  event?: string
  url?: string
}
/** One row of `gh pr checks --json name,state,bucket,workflow,link` */
export type GhCheck = {
  name: string
  state: string
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | string
  workflow?: string
  link?: string
}

export const BAD = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

/** What a card needs from a run or a set of checks. */
export type Snapshot = {
  status: RunStatus
  jobs: Job[]
  done: number
  total?: number
  passed: number
  failed: number
  skipped: number
  current?: string
  failures: string[]
  /** Changes whenever any job or step moves: what the stall watch compares. */
  signature: string
}

export function runSnapshot(run: GhRun): Snapshot {
  const jobs: Job[] = (run.jobs ?? []).map(j => {
    const steps = j.steps ?? []
    const live = steps.find(s => s.status === 'in_progress') ?? steps.find(s => s.conclusion !== null && BAD.has(s.conclusion))
    return {
      name: j.name,
      status: j.status,
      conclusion: j.conclusion ?? '',
      step: live?.name,
      stepsDone: steps.filter(s => s.status === 'completed').length,
      stepsTotal: steps.length,
    }
  })
  const status: RunStatus =
    run.status === 'completed'
      ? run.conclusion === 'cancelled'
        ? 'cancelled'
        : run.conclusion !== null && BAD.has(run.conclusion)
          ? 'failed'
          : 'passed'
      : ['queued', 'waiting', 'pending', 'requested'].includes(run.status)
        ? 'queued'
        : 'running'
  const liveJob = jobs.find(j => j.status === 'in_progress')
  const failedJobs = jobs.filter(j => BAD.has(j.conclusion))
  return {
    status,
    jobs,
    done: jobs.reduce((n, j) => n + j.stepsDone, 0),
    total: jobs.reduce((n, j) => n + j.stepsTotal, 0) || undefined,
    passed: jobs.filter(j => j.conclusion === 'success').length,
    failed: failedJobs.length,
    skipped: jobs.filter(j => j.conclusion === 'skipped' || j.conclusion === 'cancelled').length,
    current: liveJob ? `${liveJob.name} › ${liveJob.step ?? '…'}` : undefined,
    failures: failedJobs.map(j => (j.step ? `${j.name} › ${j.step}` : j.name)),
    signature: JSON.stringify([run.status, jobs.map(j => [j.status, j.conclusion, j.stepsDone])]),
  }
}

const CONCLUSION: Record<string, string> = { pass: 'success', fail: 'failure', cancel: 'cancelled', skipping: 'skipped' }

export function checksSnapshot(checks: readonly GhCheck[]): Snapshot {
  const jobs: Job[] = checks.map(c => {
    const isPending = c.bucket === 'pending'
    return {
      name: c.workflow ? `${c.workflow} › ${c.name}` : c.name,
      status: isPending ? (/^(QUEUED|PENDING|WAITING|REQUESTED|EXPECTED)$/.test(c.state) ? 'queued' : 'in_progress') : 'completed',
      conclusion: isPending ? '' : (CONCLUSION[c.bucket] ?? c.state.toLowerCase()),
      stepsDone: 0,
      stepsTotal: 0,
    }
  })
  const pending = jobs.filter(j => j.status !== 'completed')
  const failedJobs = jobs.filter(j => BAD.has(j.conclusion))
  const status: RunStatus =
    jobs.length === 0
      ? 'queued'
      : pending.length > 0
        ? pending.every(j => j.status === 'queued')
          ? 'queued'
          : 'running'
        : failedJobs.length > 0
          ? 'failed'
          : jobs.some(j => j.conclusion === 'cancelled')
            ? 'cancelled'
            : 'passed'
  const live = jobs.find(j => j.status === 'in_progress')
  return {
    status,
    jobs,
    done: jobs.length - pending.length,
    total: jobs.length || undefined,
    passed: jobs.filter(j => j.conclusion === 'success').length,
    failed: failedJobs.length,
    skipped: jobs.filter(j => j.conclusion === 'skipped' || j.conclusion === 'cancelled').length,
    current: live?.name,
    failures: failedJobs.map(j => j.name),
    signature: JSON.stringify(jobs.map(j => [j.name, j.status, j.conclusion])),
  }
}

/**
 * Runs worth tracking from a `gh run list`: not tracked yet, for the pushed commit
 * (`sha`, full or short) when known, else created after `since` (30 s of clock skew allowed).
 */
export function newRuns(
  rows: readonly GhRunRow[],
  known: ReadonlySet<string>,
  filter: { since?: number; sha?: string },
): GhRunRow[] {
  return rows.filter(r => {
    if (known.has(`gh:${r.databaseId}`)) return false
    if (filter.sha !== undefined) return r.headSha !== undefined && r.headSha.startsWith(filter.sha)
    if (filter.since !== undefined && r.createdAt !== undefined && Date.parse(r.createdAt) < filter.since - 30_000) return false
    return true
  })
}

const isActive = (r: Run) => r.status === 'running' || r.status === 'queued' || r.status === 'stalled'

/** Finished runs the agent has not heard about: one message per group, once the whole group has ended. */
export function finishedToReport(list: readonly Run[]): Run[][] {
  const out: Run[][] = []
  const groups = new Map<string, Run[]>()
  for (const r of list) {
    if (isActive(r) || !r.wakeOnFinish || r.isReported) continue
    if (!r.group) out.push([r])
    else groups.set(r.group, [...(groups.get(r.group) ?? []), r])
  }
  for (const [g, members] of groups) {
    if (!list.some(r => r.group === g && isActive(r))) out.push(members)
  }
  return out
}

/** `To github.com:owner/repo.git` and `abc123..def456  main -> main` from git push's output. */
export function pushedTo(output: string): { repo?: string; dst?: string; sha?: string } {
  const repo = output.match(
    // https://github.com/o/r, git@github.com:o/r, github.com:o/r, ssh://git@github.com/o/r, an ssh alias like github-work:o/r
    /^To\s+(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|(?:[\w.-]+@)?[\w.-]*github[\w.-]*:(?!\/\/)|ssh:\/\/(?:[\w.-]+@)?github\.com(?::\d+)?\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?\s*$/m,
  )?.[1]
  // `   1a2b3c4..5d6e7f8  main -> main`, ` * [new branch]      feat -> feat`, `+ a...b  main -> main (forced update)`
  const line = output.match(/^\s*[+*\-=! ]?\s*(\[[^\]]+\]|\S+)\s+(\S+)\s+->\s+(\S+)(?:\s+\(.*\))?\s*$/m)
  const sha = /^[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40})$/.exec(line?.[1] ?? '')?.[1]
  return { repo, dst: line?.[3]?.replace(/^refs\/(?:heads|tags)\//, ''), sha }
}

