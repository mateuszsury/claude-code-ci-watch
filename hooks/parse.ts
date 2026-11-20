import type { Tally } from '../types'

// Reads test-runner output chunk by chunk and keeps a running tally:
// pytest, jest, vitest, playwright, mocha, go test, cargo test, dotnet test,
// tsc, eslint, and any "[n/m]" step counter (docker build, turbo, ...).

export const emptyTally = (): Tally => ({
  done: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  failures: [],
  tail: [],
  carry: '',
})

const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g

const MAX_FAILURES = 50
const TAIL = 3

type Kind = 'pass' | 'fail' | 'skip'

function add(s: Tally, kind: Kind, name?: string) {
  s.done += 1
  if (kind === 'pass') s.passed += 1
  else if (kind === 'fail') s.failed += 1
  else s.skipped += 1
  if (name !== undefined) {
    s.current = name
    if (kind === 'fail') fail(s, name)
  }
  if (s.total !== undefined && s.done > s.total) s.total = s.done
}

function fail(s: Tally, name: string) {
  const clean = name.trim().slice(0, 300)
  if (clean === '' || s.failures.includes(clean)) return
  s.failures.push(clean)
  if (s.failures.length > MAX_FAILURES) s.failures.shift()
}

function setFinal(
  s: Tally,
  counts: { passed: number; failed: number; skipped: number },
  total?: number,
) {
  s.passed = counts.passed
  s.failed = counts.failed
  s.skipped = counts.skipped
  s.done = counts.passed + counts.failed + counts.skipped
  s.total = Math.max(total ?? 0, s.done, s.total ?? 0) || undefined
}

function countWords(text: string) {
  const out = { passed: 0, failed: 0, skipped: 0 }
  for (const m of text.matchAll(/(\d+)\s+([a-z ]+?)(?=,|\||;|\(|$)/gi)) {
    const n = Number(m[1])
    const word = (m[2] ?? '').trim().toLowerCase()
    if (/^(passed|passing|xpassed|flaky|ok)$/.test(word)) out.passed += n
    else if (/^(failed|failing|errors?|broken)$/.test(word)) out.failed += n
    else if (/^(skipped|pending|xfailed|ignored|todo|did not run)$/.test(word))
      out.skipped += n
  }
  return out
}

function pushTail(s: Tally, line: string) {
  const t = line.trim()
  if (t === '') return
  s.tail.push(t.length > 300 ? t.slice(0, 300) + '…' : t)
  if (s.tail.length > TAIL) s.tail.shift()
}

const is = (s: Tally, fw: string) => s.framework === undefined || s.framework === fw
const claim = (s: Tally, fw: string) => {
  if (s.framework === undefined || s.framework === 'steps') {
    if (s.framework === 'steps') {
      s.done = 0
      s.total = undefined
    }
    s.framework = fw
  }
}

// What wrappers put in front of a runner's own line, stripped until none is left:
const PREFIXES = [
  /^[\w.-]+\s+\|\s?/, // docker compose up: "tests-1  | "
  /^#\d+ \d+(?:\.\d+)? /, // docker build --progress=plain: "#7 0.322 "
  /^\[[^\]\n]+\]\s+\|\s?/, // act: "[CI/test]   | "
  /^[^\t\n]+\t[^\t\n]+\t(?=\d{4}-\d\d-\d\dT)/, // gh run view --log: "job\tstep\t"
  /^\d{4}-\d\d-\d\dT[\d:.]+Z\s/, // GitHub Actions log timestamp
]

export function unwrap(raw: string): string {
  let l = raw
  for (let round = 0; round < 4; round++) {
    const before = l
    for (const p of PREFIXES) l = l.replace(p, '')
    if (l === before) break
  }
  return l
}

function line(s: Tally, raw: string) {
  const l = unwrap(raw).replace(/\s+$/, '')
  if (l.trim() === '') return
  pushTail(s, l)
  let m: RegExpMatchArray | null

  // ---------- pytest ----------
  if ((m = l.match(/^collected (\d+) items?/)) || (m = l.match(/\bgw\d+ \[(\d+)\]/))) {
    claim(s, 'pytest')
    s.total = Number(m[1])
    return
  }
  if (is(s, 'pytest')) {
    // xdist verbose: "[gw1] [ 10%] PASSED tests/a.py::test_x"
    m = l.match(/\]\s+(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\s+(\S+::\S.*)$/)
    // verbose: "tests/a.py::test_x PASSED   [ 10%]"
    const v = m ? null : l.match(/^(\S+::\S.*?)\s+(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/)
    if (m || v) {
      claim(s, 'pytest')
      const word = m ? m[1] : v![2]
      const name = m ? m[2] : v![1]
      add(s, word === 'PASSED' || word === 'XPASS' ? 'pass' : word === 'FAILED' || word === 'ERROR' ? 'fail' : 'skip', name)
      return
    }
    // quiet: "tests/a.py ..F.s  [ 24%]"
    m = l.match(/^(\S+\.py)\s+([.FEsxX]+)\s*(?:\[\s*\d+%\])?$/) ?? l.match(/^()([.FEsxX]+)\s*\[\s*\d+%\]$/)
    if (m) {
      claim(s, 'pytest')
      for (const ch of m[2] ?? '') add(s, ch === '.' || ch === 'X' ? 'pass' : ch === 'F' || ch === 'E' ? 'fail' : 'skip')
      if (m[1]) s.current = m[1]
      return
    }
    if ((m = l.match(/^(?:FAILED|ERROR) (\S+::\S+)/))) {
      claim(s, 'pytest')
      fail(s, m[1]!)
      return
    }
    if ((m = l.match(/^=+ (.*\d+ (?:passed|failed|error|errors|skipped).*?) in [\d.]+s\b.*=+$/))) {
      claim(s, 'pytest')
      setFinal(s, countWords(m[1]!))
      return
    }
  }

  // ---------- playwright ----------
  if ((m = l.match(/^Running (\d+) tests? using \d+ workers?/))) {
    claim(s, 'playwright')
    s.total = Number(m[1])
    return
  }
  if (s.framework === 'playwright') {
    if ((m = l.match(/^\[(\d+)\/(\d+)\]\s+(.*)$/))) {
      s.done = Math.max(s.done, Number(m[1]))
      s.total = Number(m[2])
      s.current = m[3]
      return
    }
    m = l.match(/^\s*(✓|✔|ok|✘|×|x|-|±)\s+(\d+)\s+(.+?)(?:\s+\((?:retry #\d+)?\)?)?(?:\s+\([\d.]+m?s\)|\s+\([\d.]+m\))?$/)
    if (m) {
      const sym = m[1] ?? ''
      add(s, sym === '✘' || sym === '×' || sym === 'x' ? 'fail' : sym === '-' ? 'skip' : 'pass', m[3])
      return
    }
    if ((m = l.match(/^\s*\d+\) (\[.+?\] › .+?)\s*─*$/))) {
      fail(s, m[1]!)
      return
    }
    if ((m = l.match(/^\s*(\d+) (passed|failed|flaky|skipped|did not run)\b/))) {
      // summary lines arrive one per kind; recompute from them as they come
      const n = Number(m[1])
      if (!s.sum) s.sum = { passed: 0, failed: 0, skipped: 0 }
      if (m[2] === 'passed' || m[2] === 'flaky') s.sum.passed += n
      else if (m[2] === 'failed') s.sum.failed += n
      else s.sum.skipped += n
      setFinal(s, s.sum, s.total)
      return
    }
  }

  // ---------- vitest ----------
  if (is(s, 'vitest')) {
    m = l.match(/^\s*(✓|×|❯|↓)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\((\d+) tests?(?:\s*\|\s*(\d+) (failed|skipped))?(?:\s*\|\s*(\d+) (failed|skipped))?\)/)
    if (m) {
      claim(s, 'vitest')
      s.current = m[2]
      if (!s.granular) {
        const n = Number(m[3])
        let f = 0
        let k = 0
        for (const [cnt, w] of [[m[4], m[5]], [m[6], m[7]]]) {
          if (cnt === undefined) continue
          if (w === 'failed') f += Number(cnt)
          else k += Number(cnt)
        }
        s.done += n
        s.failed += f
        s.skipped += k
        s.passed += n - f - k
      }
      return
    }
    if ((m = l.match(/^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/))) {
      claim(s, 'vitest')
      setFinal(s, countWords(m[1]!.replace(/\|/g, ',')), Number(m[2]))
      return
    }
  }

  // ---------- jest ----------
  if ((m = l.match(/^(PASS|FAIL)\s+(\S+\.\w+)/)) && is(s, 'jest')) {
    claim(s, 'jest')
    s.current = m[2]
    return
  }
  if ((m = l.match(/^Tests:\s+(.+?),\s*(\d+) total/)) && is(s, 'jest')) {
    claim(s, 'jest')
    setFinal(s, countWords(m[1]!), Number(m[2]))
    return
  }
  if (s.framework === 'jest' && (m = l.match(/^\s+● (.+? › .+)$/))) {
    fail(s, m[1]!)
    return
  }

  // ---------- per-test check marks (jest --verbose, vitest verbose, mocha) ----------
  if (
    s.framework === 'jest' ||
    s.framework === 'vitest' ||
    s.framework === 'mocha' ||
    s.framework === undefined
  ) {
    m = l.match(/^\s+(✓|✔|√|✕|×|✗|○|↓|-)\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s?m?s\)?)?$/)
    if (m && !/^\s*-\s+\d/.test(l)) {
      if (s.framework === undefined) s.framework = 'mocha'
      if ((s.framework === 'vitest' || s.framework === 'jest') && !s.granular) {
        s.granular = true
        s.done = s.passed = s.failed = s.skipped = 0
      }
      const sym = m[1] ?? ''
      add(s, '✕×✗'.includes(sym) ? 'fail' : '○↓-'.includes(sym) ? 'skip' : 'pass', m[2]!)
      return
    }
  }
  if (s.framework === 'mocha') {
    if ((m = l.match(/^\s+(\d+)\) (.+)$/))) {
      add(s, 'fail', m[2])
      return
    }
    if ((m = l.match(/^\s+(\d+) passing\b/))) {
      s.passed = Number(m[1])
      s.done = s.passed + s.failed + s.skipped
      return
    }
  }

  // ---------- go test ----------
  if ((m = l.match(/^=== RUN\s+(\S+)/))) {
    claim(s, 'go')
    s.current = m[1]
    return
  }
  if ((m = l.match(/^\s*--- (PASS|FAIL|SKIP): (\S+)/))) {
    claim(s, 'go')
    add(s, m[1] === 'PASS' ? 'pass' : m[1] === 'FAIL' ? 'fail' : 'skip', m[2])
    return
  }

  // ---------- cargo test ----------
  if ((m = l.match(/^running (\d+) tests?$/))) {
    claim(s, 'cargo')
    s.total = (s.total ?? 0) + Number(m[1])
    return
  }
  if ((m = l.match(/^test (\S+)(?: - .+?)? \.\.\. (ok|FAILED|ignored)/))) {
    claim(s, 'cargo')
    add(s, m[2] === 'ok' ? 'pass' : m[2] === 'FAILED' ? 'fail' : 'skip', m[1])
    return
  }

  // ---------- dotnet test ----------
  if ((m = l.match(/^(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+)/))) {
    claim(s, 'dotnet')
    if (!s.sum) s.sum = { passed: 0, failed: 0, skipped: 0 }
    s.sum.failed += Number(m[1])
    s.sum.passed += Number(m[2])
    s.sum.skipped += Number(m[3])
    setFinal(s, s.sum)
    return
  }
  if ((m = l.match(/^\s*(Passed|Failed|Skipped)\s+(\S.*?)\s+\[[\d.< ]+m?s\]/))) {
    claim(s, 'dotnet')
    if (m[1] === 'Failed') fail(s, m[2]!)
    s.current = m[2]
    add(s, m[1] === 'Passed' ? 'pass' : m[1] === 'Failed' ? 'fail' : 'skip')
    return
  }

  // ---------- tsc / eslint ----------
  if ((m = l.match(/^(\S+?)(?:\((\d+),\d+\)|:(\d+):\d+)\s*[:-]\s*error (TS\d+)/))) {
    claim(s, 'tsc')
    s.failed += 1
    fail(s, `${m[1]}:${m[2] ?? m[3]} ${m[4]}`)
    return
  }
  if ((m = l.match(/^✖ (\d+) problems? \((\d+) errors?/))) {
    claim(s, 'eslint')
    s.failed = Number(m[2])
    return
  }

  // ---------- generic step counter: "[3/8]", "#8 [builder 3/7] RUN ..." ----------
  if (s.framework === undefined || s.framework === 'steps') {
    m = l.match(/\[(?:[\w.:-]+\s+)?\s*(\d{1,5})\s*\/\s*(\d{1,5})\s*\](.*)$/)
    if (m && Number(m[1]) <= Number(m[2]) && Number(m[2]) > 1) {
      s.framework = 'steps'
      s.done = Math.max(s.done, Number(m[1]))
      s.total = Math.max(s.total ?? 0, Number(m[2]))
      const rest = (m[3] ?? '').trim()
      if (rest) s.current = rest
    }
  }
}

/** Feeds one chunk of raw output into the tally and returns the new tally. */
export function feed(t: Tally, chunk: string): Tally {
  const s: Tally = {
    ...t,
    failures: [...t.failures],
    tail: [...t.tail],
    sum: t.sum ? { ...t.sum } : undefined,
  }
  const text = (s.carry + chunk).replace(ANSI, '')
  const parts = text.split(/\r\n|\n|\r/)
  s.carry = parts.pop() ?? ''
  if (s.carry.length > 4000) s.carry = s.carry.slice(-4000)
  for (const raw of parts) line(s, raw)
  return s
}

/** Feeds the end of the stream: the unfinished last line counts too. */
export function flush(t: Tally): Tally {
  return t.carry === '' ? t : feed({ ...t }, '\n')
}

// ---------- commands ----------

// A runner named as a word of its own: not part of a path (`$DIR/tsc`) or a
// file name (`pytest.ini`).
const TEST_COMMAND =
  /(?:^|[\s;&|(`'"]|\.\/)(?:pytest|py\.test|tox|nox|jest|vitest|playwright|cypress|mocha|ava|phpunit|rspec|ctest|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|mvnw?|gradlew?|bun\s+test|deno\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|e2e|ci|check|lint|typecheck|build|verify)|npx\s+(?:tsc|eslint|playwright|vitest|jest)|tsc|eslint|make\s+(?:test|check|ci|e2e)|just\s+(?:test|ci|check)|act|docker\s+(?:compose\b.*?\s)?(?:build|run)|docker\s+compose\b.*\sup)(?![\w./\\-])|ci\.(?:sh|ps1|py)\b|\brun-tests?\b/i

// Following the logs of a test container (not of a dev server, which would read as a stall).
const TEST_LOGS = /docker\s+(?:compose\b[^|;&]*?\s)?logs\b(?=.*(?:\s-f\b|--follow))(?=.*\b(?:tests?|e2e|ci|pytest|playwright)\b)/i

// Commands that only mention a runner: reading, searching, moving files, git, printing.
const NOT_A_RUN = /^(?:git|echo|printf|cat|less|head|tail|grep|rg|sed|awk|ls|dir|rm|cp|mv|mkdir|touch|find|code|claude|which|where|type|Get-Content|Select-String|Remove-Item|Copy-Item|Write-Output|Write-Host)$/i

/** The first word of a shell segment, past env assignments and `sudo`/`time`/`timeout N`. */
function firstWord(segment: string) {
  const words = segment.trim().split(/\s+/)
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === 'sudo' || w === 'time' || w === 'env') i += 1
    else if (w === 'timeout') i += /^\d/.test(words[i + 1] ?? '') ? 2 : 1
    else break
  }
  return words[i] ?? ''
}

/** Whether a command runs tests or CI: one of its shell segments starts a runner. */
export function isTestCommand(command: string): boolean {
  if (TEST_LOGS.test(command)) return true
  // Split on separators, outside quotes, so `bash -c "cd x && pytest"` stays one segment.
  const segments: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = ''
      cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      segments.push(cur)
      cur = ''
      if (ch !== ';' && ch !== '\n' && command[i + 1] === ch) i += 1
    } else cur += ch
  }
  segments.push(cur)
  return segments.some(seg => seg.trim() !== '' && !NOT_A_RUN.test(firstWord(seg)) && TEST_COMMAND.test(seg))
}

/** A foreground command that only waits (for CI, for time to pass). */
export const isWaitCommand = (command: string) =>
  /\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b.*--watch|^\s*sleep\s+\d|\bStart-Sleep\b|\buntil\b.*\bsleep\b|\bwhile\b.*\bsleep\b|\btimeout\s+\d+\s+(?:gh|bash|sh)\b/.test(
    command,
  )

/** A GitHub Actions run named by a command: `gh run watch 123`, a runs URL. */
export function ghRunOf(command: string): { runId: string; repo?: string } | undefined {
  let m = command.match(/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/)
  if (m) return { runId: m[2]!, repo: m[1] }
  m = command.match(/\bgh\s+run\s+(?:watch|view|rerun)\s+(?:[^|;&]*?\s)?(\d{6,})\b/)
  if (!m) return undefined
  const repo = command.match(/(?:-R|--repo)[ =]([\w.-]+\/[\w.-]+)/)
  return { runId: m[1]!, repo: repo?.[1] }
}

/** A short label for a command: no `cd x &&`, no env assignments. */
export function labelOf(command: string): string {
  // A multi-line command (a heredoc, a script) is named by its test line.
  const lines = command.split('\n').map(x => x.trim()).filter(x => x !== '')
  let c = lines.find(x => !x.includes('<<') && isTestCommand(x)) ?? lines[0] ?? ''
  c = c.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, '')
  c = c.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
  c = c.replace(/\s+(?:2>&1|\|\s*tee\b.*|>\s*\S+)$/g, '')
  return c.length > 70 ? c.slice(0, 69) + '…' : c
}

/** The output file a background command writes, from the tool's text. */
export const outputPathOf = (text: string) =>
  text.match(/Output is being written to:\s*(.+?\.output)\b/)?.[1]

export const taskIdOf = (text: string) =>
  text.match(/running in background with ID:\s*([\w-]+)/)?.[1]

/** `<task-notification>` rows: which task ended, how. */
export function taskEndOf(text: string):
  | { taskId: string; status: string; exitCode?: number }
  | undefined {
  if (!text.includes('<task-notification>')) return undefined
  const id = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
  const status = text.match(/<status>([^<]+)<\/status>/)?.[1]
  if (!id || !status) return undefined
  const code = text.match(/exit code (-?\d+)/)?.[1]
  return { taskId: id, status, exitCode: code === undefined ? undefined : Number(code) }
}
