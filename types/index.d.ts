/** What the parser keeps for one stream of test output. */
export type Tally = {
  /** pytest, jest, vitest, playwright, go, cargo, dotnet, mocha, tsc, eslint, steps */
  framework?: string
  total?: number
  done: number
  passed: number
  failed: number
  skipped: number
  /** The test (or step) running or finished last. */
  current?: string
  /** Names of failed tests, newest last, at most 50. */
  failures: string[]
  /** Last few non-empty lines of output. */
  tail: string[]
  /** The unfinished last line, kept for the next chunk. */
  carry: string
  /** Vitest/jest: per-test lines were seen, so per-file counts are ignored. */
  granular?: boolean
  /** Summed per-assembly summaries (dotnet). */
  sum?: { passed: number; failed: number; skipped: number }
}

/** One GitHub Actions job. */
export type Job = {
  name: string
  status: string
  conclusion: string
  step?: string
  stepsDone: number
  stepsTotal: number
}

export type RunStatus =
  | 'running'
  | 'queued'
  | 'stalled'
  | 'passed'
  | 'failed'
  | 'cancelled'

export type Run = Tally & {
  id: string
  /** log: a background command's output file; fg: a foreground command; gh: a GitHub Actions run. */
  kind: 'log' | 'fg' | 'gh'
  label: string
  status: RunStatus
  path?: string
  offset: number
  taskId?: string
  ghRunId?: string
  repo?: string
  /** Where `gh` runs when no repo is named. */
  cwd?: string
  url?: string
  jobs?: Job[]
  exitCode?: number
  startedAt: number
  firstProgressAt?: number
  lastOutputAt: number
  lastChangeAt: number
  endedAt?: number
  stallMs: number
  /** The stall alert for the current silence was already sent. */
  isAlerted: boolean
  /** Tell the agent when this run ends (GitHub runs: the harness does not). */
  wakeOnFinish: boolean
}

export type TurnState = { isBusy: boolean; turnId?: string }

declare module 'claude-code' {
  interface PluginState {
    'ci-watch': {
      runs: Shaped<Run[]>
      now: number
      turn: TurnState
    }
  }
}
