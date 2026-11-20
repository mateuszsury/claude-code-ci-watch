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
  const isOpen = s.framework === undefined || s.framework === 'steps' || s.framework === 'rust'
  if (isOpen) {
    m = l.match(/\[(?:[\w.:-]+\s+)?\s*(\d{1,5})\s*\/\s*(\d{1,5})\s*\](.*)$/)
    if (m && Number(m[1]) <= Number(m[2]) && Number(m[2]) > 1) {
      if (s.framework === 'rust') s.done = 0
      s.framework = 'steps'
      s.done = Math.max(s.done, Number(m[1]))
      s.total = Math.max(s.total ?? 0, Number(m[2]))
      const rest = (m[3] ?? '').trim()
      if (rest) s.current = rest
      return
    }
    // cargo: `Building [=====>   ] 123/456: crate` (a terminal), else one `Compiling crate v1` per crate.
    if ((m = l.match(/^\s*Building \[[=> ]*\]\s+(\d+)\/(\d+)(?::\s*(.*))?$/))) {
      if (s.framework === undefined) s.framework = 'rust'
      if (s.framework === 'rust') {
        s.done = Number(m[1])
        s.total = Number(m[2])
      }
      if (m[3]) s.current = `Compiling ${m[3]}`
      return
    }
    if ((m = l.match(/^\s*(Compiling|Checking|Documenting) (\S+) v\S+/))) {
      if (s.framework === undefined) s.framework = 'rust'
      if (s.framework === 'rust' && s.total === undefined) s.done += 1
      s.current = `${m[1]} ${m[2]}`
      return
    }
    // Anything that prints a percentage: git (`Receiving objects:  45% (123/456)`), webpack, gradle, pip, npm.
    const pcts = [...l.matchAll(/(?:^|[\s[(:])(\d{1,3}(?:\.\d+)?)\s?%(?![\w%])/g)].map(x => Number(x[1])).filter(x => x <= 100)
    if (pcts.length > 0) s.percent = pcts[pcts.length - 1]
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
//
// Which commands are worth a card: tests and checks, builds, deploys. The command
// is tokenized like a shell would (quotes, heredocs), wrappers are looked through
// (`bash -c`, `ssh host …`, `docker compose run svc …`, `uv run …`), and only the
// word that is actually run decides, so a runner named in a path, a commit message,
// an inline script or a heredoc body never counts.

export type Category = 'tests' | 'build' | 'deploy'

const RANK: Record<Category, number> = { build: 1, tests: 2, deploy: 3 }
const best = (a: Category | undefined, b: Category | undefined) =>
  a === undefined ? b : b === undefined ? a : RANK[b] > RANK[a] ? b : a

/** The shell segments of a command, split on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes. */
/** A backslash escapes only these, as in bash, so Windows paths (`C:\Users\x`, `.\deploy\ci.ps1`) keep theirs. */
const isEscaped = (next: string | undefined) => next !== undefined && /["\\$`\s']/.test(next)

/**
 * Walks a command as a shell reads it: quotes (with `\` escapes outside single
 * quotes) and `$(…)` / backtick substitutions are opaque. `at` is called for each
 * character outside them, with `cur` the text so far.
 */
function scan(text: string, at: (ch: string, i: number) => 'split' | 'skip' | 'keep'): { pieces: string[]; quoted: boolean[] } {
  const pieces: string[] = []
  const quoted: boolean[] = []
  let cur = ''
  let hasQuote = false
  let quote = ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      cur += ch
    } else if (ch === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      cur += ' ' // a line continuation
      i += text[i + 1] === '\r' ? 2 : 1
    } else if (ch === '\\' && isEscaped(text[i + 1])) {
      cur += ch + text[i + 1]!
      i += 1
    } else if (quote === '"' || quote === '`') {
      if (ch === quote) quote = ''
      cur += ch
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      hasQuote = true
      cur += ch
    } else if (ch === '$' && text[i + 1] === '(') {
      depth += 1
      cur += '$('
      i += 1
    } else if (depth > 0) {
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
      cur += ch
    } else {
      const act = at(ch, i)
      if (act === 'split') {
        pieces.push(cur)
        quoted.push(hasQuote)
        cur = ''
        hasQuote = false
      } else if (act === 'keep') cur += ch
    }
  }
  pieces.push(cur)
  quoted.push(hasQuote)
  return { pieces, quoted }
}

/** The shell segments of a command, split on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes. */
export function segmentsOf(command: string): string[] {
  let skipNext = false
  const { pieces } = scan(command, (ch, i) => {
    if (skipNext) {
      skipNext = false
      return 'skip'
    }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && command[i - 1] !== '>' && command[i + 1] !== '>')) {
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) skipNext = true
      return 'split'
    }
    return 'keep'
  })
  return pieces.map(s => s.trim()).filter(s => s !== '')
}

/** Removes one level of shell quoting from a word: `"a b"` → `a b`, `\"` → `"`. */
function dequote(w: string): string {
  let out = ''
  let quote = ''
  for (let i = 0; i < w.length; i++) {
    const ch = w[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      else out += ch
    } else if (ch === '\\' && isEscaped(w[i + 1])) {
      out += w[i + 1]!
      i += 1
    } else if (quote === '"') {
      if (ch === '"') quote = ''
      else out += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else out += ch
  }
  return out
}

/** Shell words of a segment, quotes removed; redirections (`2>&1`, `> f`, `< f`) dropped. */
export function tokensOf(segment: string): string[] {
  const { pieces, quoted } = scan(segment, ch => (/\s/.test(ch) ? 'split' : 'keep'))
  const out = pieces.flatMap((p, i) => (p !== '' || quoted[i] ? [dequote(p)] : []))
  const words: string[] = []
  for (let i = 0; i < out.length; i++) {
    const w = out[i]!
    if (/^\d?[<>]{1,2}&?\d*$|^&>>?$/.test(w)) i += /&\d$/.test(w) ? 0 : 1 // `> file`, `2> file`
    else if (/^\d?[<>]{1,2}&?\S/.test(w) || /^&>/.test(w)) continue // `>file`, `2>&1`
    else words.push(w)
  }
  return words
}

/** Heredoc bodies leave the command; a body fed to a shell (`bash -s <<EOF`, `ssh host <<EOF`) is kept as commands. */
export function splitHeredocs(command: string): { text: string; scripts: string[] } {
  const scripts: string[] = []
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = line.match(/<<-?\s*(['"]?)([\w.-]+)\1/)
    kept.push(line)
    if (!m) continue
    const end = m[2]!
    const body: string[] = []
    let j = i + 1
    while (j < lines.length && lines[j]!.trim() !== end) body.push(lines[j++]!)
    i = j
    const feeder = line.slice(0, m.index)
    if (/(?:^|[\s;&|(])(?:bash|sh|zsh|dash)(?:\s+-[a-z]+)*\s*['"]?\s*$|(?:^|[\s;&|(])ssh\s+(?:-\S+\s+(?:\S+\s+)?)*[\w@.:-]+\s*['"]?(?:bash|sh)?(?:\s+-s)?['"]?\s*$/.test(feeder)) {
      scripts.push(body.join('\n'))
    }
  }
  return { text: kept.join('\n'), scripts }
}

// Words that never start a test, build or deploy themselves.
const PASSIVE = new Set(
  (
    'git gh cd pushd popd echo printf cat less more head tail grep egrep fgrep rg sed awk ls dir rm rmdir cp mv mkdir touch find fd code claude ' +
    'which where whereis type test [ [[ export set unset source . read wc sort uniq cut tr tee jq yq curl wget diff cmp stat du df chmod chown ln ' +
    'tar zip unzip gzip gunzip 7z scp rsync open start explorer clip pbcopy xclip sleep true false : for while until if case function return exit ' +
    'local declare trap wait kill pkill taskkill ps top htop history alias cygpath realpath dirname basename date whoami hostname uname printenv ' +
    'get-content get-childitem select-string select-object where-object foreach-object remove-item copy-item move-item new-item set-content ' +
    'add-content out-file write-output write-host set-location get-location test-path get-process stop-process start-sleep get-date measure-object ' +
    'sort-object format-table format-list convertfrom-json convertto-json invoke-webrequest invoke-restmethod'
  ).split(' '),
)

const PREFIX = new Set(['sudo', 'time', 'env', 'nice', 'nohup', 'command', 'exec', 'do', 'then', 'else', '{', '(', '!', 'stdbuf', 'unbuffer'])

/** The words that run: past env assignments, `sudo`, `timeout 600`, `do`, PowerShell `&`. */
function runWords(raw: string[]): string[] {
  // A subshell's parentheses: `(cd x && npm run build)`.
  const tokens = raw.map((w, k) => (k === 0 ? w.replace(/^\(+(?!\()/, '') : w)).filter((w, k) => !(w === ')' && k === raw.length - 1) && w !== '')
  if (tokens.length > 0 && /\)$/.test(tokens[tokens.length - 1]!) && !tokens[tokens.length - 1]!.includes('(')) tokens[tokens.length - 1] = tokens[tokens.length - 1]!.replace(/\)+$/, '')
  let i = 0
  while (i < tokens.length) {
    const w = tokens[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX.has(w) || w === '&') i += 1
    else if (w === 'timeout' || w === 'retry') {
      i += 1
      while (i < tokens.length && (tokens[i]!.startsWith('-') || /^\d+[smhd]?$/.test(tokens[i]!))) i += 1
    } else if (/^-[a-zA-Z]$/.test(w) && tokens[i - 1] === 'env') i += 2
    else break
  }
  return tokens.slice(i)
}

const parts = (name: string) =>
  name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .split(/[-_.:\s/]+/)
    .filter(Boolean)

const TEST_PARTS = new Set(['test', 'tests', 'ci', 'e2e', 'check', 'checks', 'verify', 'lint', 'qa', 'gate', 'spec', 'specs', 'typecheck', 'integration', 'smoke'])
const BUILD_PARTS = new Set(['build', 'rebuild', 'compile', 'bundle', 'package', 'dist', 'assemble', 'image', 'images'])
const DEPLOY_PARTS = new Set(['deploy', 'release', 'rollout', 'publish', 'ship', 'promote'])
/** A deploy tool asked something rather than told to deploy: `app-release web status`. */
const READONLY = new Set(['status', 'ps', 'logs', 'log', 'list', 'ls', 'history', 'show', 'inspect', 'diff', 'plan', 'describe', 'get', 'version', '--version', '-v', 'help', '--help', '-h', '--dry-run', 'dry-run', 'config', 'doctor', 'info'])

/** A task, script or target named for what it does: `test:e2e`, `Invoke-LocalCI.ps1`, `deploy-prod`, `app-release`. */
function nameCategory(name: string, allowDeploy = true): Category | undefined {
  const p = parts(name.replace(/^.*[\\/]/, ''))
  const lower = name.toLowerCase().replace(/^.*[\\/]/, '')
  if (allowDeploy && (p.some(x => DEPLOY_PARTS.has(x)) || /^\w*(deploy|release|rollout)\w*$/.test(lower.replace(/\.[a-z0-9]+$/, '')))) return 'deploy'
  if (p.some(x => TEST_PARTS.has(x))) return 'tests'
  if (p.some(x => BUILD_PARTS.has(x))) return 'build'
  return undefined
}

const isScriptPath = (w: string) => /[\\/]/.test(w) || /\.(?:sh|bash|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl)$/i.test(w)

const TEST_TOOLS = new Set(['pytest', 'py.test', 'tox', 'nox', 'jest', 'vitest', 'mocha', 'ava', 'phpunit', 'rspec', 'ctest', 'act', 'tsc', 'vue-tsc', 'eslint', 'mypy', 'pyright', 'golangci-lint', 'phpstan', 'pest', 'karma', 'jasmine', 'wdio', 'detox', 'stylelint', 'hadolint', 'shellcheck', 'tflint', 'markdownlint'])
const BUILD_TOOLS = new Set(['pyinstaller', 'msbuild', 'ninja', 'xcodebuild', 'electron-builder', 'webpack', 'rollup', 'esbuild', 'tsup', 'parcel', 'nuitka', 'maturin', 'wasm-pack'])
const PM = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const RUN_THROUGH = new Set(['npx', 'pnpx', 'bunx', 'dlx'])
const TASK_RUNNERS = new Set(['make', 'gmake', 'just', 'task', 'mage', 'rake', 'invoke', 'inv', 'nx', 'turbo', 'lerna', 'mise', 'moon', 'earthly', 'dagger'])
const INTERPRETER = /^(?:python[\d.]*|py|pypy[\d.]*|node|ruby|perl|php|pwsh|powershell)(?:\.exe)?$/i
const RUN_VALUED = new Set(['-e', '--env', '-v', '--volume', '-w', '--workdir', '-p', '--publish', '-u', '--user', '--network', '--net', '--name', '--entrypoint', '--platform', '--env-file', '--mount', '-l', '--label', '--add-host', '--cpus', '-m', '--memory', '--gpus', '--ulimit', '--pull', '--restart', '--hostname', '-h', '--shm-size', '--cap-add', '--device', '--log-driver', '--log-opt', '--dns', '--ipc', '--pid', '--security-opt', '--tmpfs', '--volumes-from', '--link', '--expose', '--health-cmd', '--stop-signal', '--cidfile', '--ip', '--group-add'])
const COMPOSE_VALUED = new Set(['-f', '--file', '-p', '--project-name', '--env-file', '--profile', '--ansi', '--project-directory', '--progress', '--parallel'])

function skipFlags(words: string[], valued: Set<string>): number {
  let i = 0
  while (i < words.length && words[i]!.startsWith('-')) {
    const w = words[i]!
    i += !w.includes('=') && valued.has(w) ? 2 : 1
  }
  return i
}

/** `docker run [opts] image [cmd…]`, `docker compose run|exec [opts] svc [cmd…]`: what runs inside, else the image's or service's name. */
function insideContainer(args: string[], depth: number): Category | undefined {
  const i = skipFlags(args, RUN_VALUED)
  const target = args[i]
  if (target === undefined) return undefined
  const cmd = args.slice(i + 1)
  const inner = cmd.length > 0 ? wordsCategory(cmd, depth + 1) : undefined
  if (inner !== undefined) return inner
  const named = nameCategory(target.replace(/[:@].*$/, ''), false)
  return named === 'tests' ? 'tests' : undefined
}

function dockerCategory(args: string[], depth: number): Category | undefined {
  let i = skipFlags(args, new Set(['--context', '-c', '-H', '--host', '--log-level', '--config']))
  const sub = args[i]
  if (sub === 'build') return 'build'
  if (sub === 'buildx' || sub === 'image') return args[i + 1] === 'build' || args[i + 1] === 'bake' ? 'build' : args[i + 1] === 'push' ? 'deploy' : undefined
  if (sub === 'push' || sub === 'save') return 'deploy'
  if (sub === 'run' || sub === 'exec') return insideContainer(args.slice(i + 1), depth)
  if (sub === 'container') return args[i + 1] === 'run' || args[i + 1] === 'exec' ? insideContainer(args.slice(i + 2), depth) : undefined
  if (sub !== 'compose') return undefined
  return composeCategory(args.slice(i + 1), depth)
}

function composeCategory(args: string[], depth: number): Category | undefined {
  const i = skipFlags(args, COMPOSE_VALUED)
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (sub === 'build') return 'build'
  if (sub === 'push') return 'deploy'
  if (sub === 'run' || sub === 'exec') return insideContainer(rest, depth)
  // A test stack runs attached and ends with its tests; `up -d` starts services and returns.
  if (sub === 'up') return rest.some(w => /^--(abort-on-container-exit|exit-code-from)/.test(w)) ? 'tests' : undefined
  if (sub === 'logs') {
    const follows = rest.some(w => w === '-f' || w === '--follow')
    return follows && rest.some(w => !w.startsWith('-') && nameCategory(w, false) === 'tests') ? 'tests' : undefined
  }
  return undefined
}

/** The category of one simple command, given its words. */
function wordsCategory(tokens: string[], depth: number): Category | undefined {
  if (depth > 4) return undefined
  const words = runWords(tokens)
  const w0 = words[0]
  if (w0 === undefined) return undefined
  const base = w0.replace(/^.*[\\/]/, '').toLowerCase()
  const rest = words.slice(1)
  const sub = rest.find(w => !w.startsWith('-'))?.toLowerCase()
  if (/^\$[\w:]+$/.test(w0) && rest[0] === '=') return undefined // PowerShell `$x = …`
  if (PASSIVE.has(base) || PASSIVE.has(base.replace(/\.exe$/, ''))) return undefined
  // Asked for its version or help, not run.
  if (rest.some(w => w === '--version' || w === '--help' || w === '-V') && base !== 'ssh') return undefined

  // Shells and remote shells: what they run.
  if (/^(?:bash|sh|zsh|dash|wsl)(?:\.exe)?$/.test(base)) {
    if (rest.some(w => /^-[a-z]*n[a-z]*$/.test(w) && w !== '-c')) return undefined // `bash -n script`: a syntax check
    const c = rest.indexOf('-c')
    if (c >= 0) return classify(rest[c + 1] ?? '', depth + 1)
    const script = rest.find(w => !w.startsWith('-'))
    return script ? nameCategory(script) : undefined
  }
  if (/^(?:pwsh|powershell)(?:\.exe)?$/.test(base)) {
    const f = rest.findIndex(w => /^-f(ile)?$/i.test(w))
    if (f >= 0) return nameCategory(rest[f + 1] ?? '')
    const c = rest.findIndex(w => /^-c(ommand)?$/i.test(w))
    if (c >= 0) return classify(rest.slice(c + 1).join(' '), depth + 1)
    return undefined
  }
  if (base === 'cmd' || base === 'cmd.exe') {
    const c = rest.findIndex(w => /^\/[ck]$/i.test(w))
    return c >= 0 ? classify(rest.slice(c + 1).join(' '), depth + 1) : undefined
  }
  if (base === 'ssh') {
    let i = 0
    while (i < rest.length && rest[i]!.startsWith('-')) i += /^-[oiplJFEcmbDLRSWw]$/.test(rest[i]!) ? 2 : 1
    const remote = rest.slice(i + 1).join(' ')
    return remote ? classify(remote, depth + 1) : undefined
  }

  // Containers.
  if (base === 'docker' || base === 'podman' || base === 'docker.exe') return dockerCategory(rest, depth)
  if (base === 'docker-compose' || base === 'podman-compose') return composeCategory(rest, depth)

  // Package managers and runners in front of a tool.
  if (RUN_THROUGH.has(base)) return wordsCategory(rest.slice(skipFlags(rest, new Set(['-p', '--package']))), depth + 1)
  if (/^(?:uv|poetry|pipenv|hatch|pdm|rye|conda|mamba|pixi)$/.test(base) && sub === 'run') {
    const after = rest.slice(rest.indexOf('run') + 1)
    return wordsCategory(after.slice(skipFlags(after, new Set(['-n', '--name', '-p', '--prefix', '--with', '--python', '-e', '--env']))), depth + 1)
  }
  if (base === 'bundle' && sub === 'exec') return wordsCategory(rest.slice(rest.indexOf('exec') + 1), depth + 1)
  if (PM.has(base)) {
    if (sub === undefined) return undefined
    if (sub === 'test' || sub === 't') return 'tests'
    if (sub === 'publish') return 'deploy'
    if (base === 'bun' && sub === 'build') return 'build'
    if (sub === 'exec' || sub === 'dlx' || sub === 'x') return wordsCategory(rest.slice(rest.indexOf(sub) + 1), depth + 1)
    if (sub === 'run' || sub === 'run-script') {
      const script = rest.slice(rest.indexOf(sub) + 1).find(w => !w.startsWith('-'))
      return script ? nameCategory(script) : undefined
    }
    // `pnpm build`, `yarn e2e`: a script by its name; installs and the rest are nothing.
    if (/^(?:i|install|ci|add|remove|rm|uninstall|update|up|upgrade|outdated|audit|init|create|link|pack|login|whoami|config|cache|view|info|why|ls|list|dedupe|prune|rebuild|version|help|start|dev|serve|preview)$/.test(sub)) return undefined
    return base === 'npm' ? undefined : nameCategory(sub)
  }
  if (TASK_RUNNERS.has(base)) {
    let cat: Category | undefined
    for (const t of rest.filter(w => !w.startsWith('-') && !/^\w+=/.test(w)).slice(0, 4)) cat = best(cat, nameCategory(t))
    return cat
  }

  // Language toolchains.
  if (base === 'cargo') {
    if (/^(?:test|t|nextest|clippy|check|c|fmt|miri|bench)$/.test(sub ?? '')) return sub === 'fmt' && !rest.includes('--check') ? undefined : 'tests'
    if (/^(?:build|b|install)$/.test(sub ?? '')) return 'build'
    if (sub === 'publish') return 'deploy'
    if (sub === 'tauri') return rest.includes('build') ? 'build' : undefined
    return undefined
  }
  if (base === 'go' || base === 'go.exe') return sub === 'test' || sub === 'vet' ? 'tests' : sub === 'build' || sub === 'install' ? 'build' : undefined
  if (base === 'dotnet' || base === 'dotnet.exe') return sub === 'test' ? 'tests' : sub === 'build' || sub === 'publish' || sub === 'pack' ? 'build' : undefined
  if (/^(?:mvn|mvnw|mvnw\.cmd|gradle|gradlew|gradlew\.bat)$/.test(base)) {
    let cat: Category | undefined
    for (const t of rest.filter(w => !w.startsWith('-')).slice(0, 6)) cat = best(cat, parts(t).includes('publish') || t === 'deploy' ? 'deploy' : nameCategory(t, false))
    return cat
  }
  if (base === 'deno') return sub === 'test' || sub === 'lint' || sub === 'check' ? 'tests' : sub === 'compile' ? 'build' : undefined
  if (base === 'swift' || base === 'flutter' || base === 'dart') return sub === 'test' || sub === 'analyze' ? 'tests' : sub === 'build' ? 'build' : undefined
  if (base === 'ruff' || base === 'biome') return /^(?:check|lint|ci|format)$/.test(sub ?? '') && (sub !== 'format' || rest.includes('--check')) ? 'tests' : undefined
  if (base === 'playwright') return sub === 'test' ? 'tests' : undefined
  if (base === 'cypress') return sub === 'run' ? 'tests' : undefined
  if (base === 'bazel' || base === 'bazelisk') return sub === 'test' ? 'tests' : sub === 'build' ? 'build' : undefined
  if (base === 'cmake') return rest.includes('--build') ? 'build' : undefined
  if (/^(?:vite|next|nuxt|astro|svelte-kit|remix|ng|tauri|expo|eas)$/.test(base)) return sub === 'build' || sub === 'export' ? 'build' : sub === 'test' ? 'tests' : undefined

  // Interpreters: `python -m pytest` is pytest; `node -e …` and `py - <<EOF` are inline code.
  if (INTERPRETER.test(base)) {
    const m = rest.indexOf('-m')
    if (m >= 0 && rest[m + 1]) return wordsCategory(rest.slice(m + 1), depth + 1)
    if (rest.some(w => w === '-c' || w === '-e' || w === '-p' || w === '-' || w === '--eval' || w === '--print')) return undefined
    const script = rest.find(w => !w.startsWith('-'))
    return script ? nameCategory(script) : undefined
  }

  // Deploy tools.
  if (/^(?:kubectl|oc)$/.test(base)) return sub === 'apply' || sub === 'rollout' || sub === 'set' || sub === 'replace' ? 'deploy' : undefined
  if (base === 'helm') return sub === 'upgrade' || sub === 'install' || sub === 'rollback' ? 'deploy' : undefined
  if (base === 'terraform' || base === 'tofu' || base === 'terragrunt') return sub === 'apply' || sub === 'destroy' ? 'deploy' : undefined
  if (base === 'pulumi') return sub === 'up' || sub === 'destroy' ? 'deploy' : undefined
  if (base === 'ansible-playbook') return 'deploy'
  if (/^(?:wrangler|firebase|fly|flyctl|vercel|netlify|railway|serverless|sls|sam|cdk|eb|heroku|amplify|render|doctl|caprover)$/.test(base)) return sub === 'deploy' || sub === 'publish' || rest.includes('deploy') ? 'deploy' : undefined
  if ((base === 'gcloud' || base === 'az' || base === 'aws') && rest.some(w => w === 'deploy' || w === 'update-function-code' || w === 'update-service')) return 'deploy'
  if (base === 'twine' && sub === 'upload') return 'deploy'
  if (base === 'cap' && rest.includes('deploy')) return 'deploy'

  // Tools named for one job.
  if (TEST_TOOLS.has(base.replace(/\.(?:exe|cmd)$/, ''))) return 'tests'
  if (BUILD_TOOLS.has(base.replace(/\.(?:exe|cmd)$/, ''))) return 'build'

  // Anything else is named for what it does: `./scripts/ci.sh`, `app-release web stopstart`, `run-tests`.
  const named = nameCategory(w0)
  if (named === 'deploy' && rest.slice(0, 3).some(w => READONLY.has(w.toLowerCase()))) return undefined
  if (named !== undefined && (isScriptPath(w0) || named === 'deploy' || /^run[-_]?tests?$/i.test(base))) return named
  return undefined
}

/** What a command runs, if it is worth a card: tests and checks, a build, a deploy. */
export function classify(command: string, depth = 0): Category | undefined {
  if (depth > 4) return undefined
  const { text, scripts } = splitHeredocs(command)
  let cat: Category | undefined
  for (const seg of segmentsOf(text)) cat = best(cat, wordsCategory(tokensOf(seg), depth))
  for (const script of scripts) cat = best(cat, classify(script, depth + 1))
  return cat
}

export const isTestCommand = (command: string) => classify(command) === 'tests'
export const isDeployCommand = (command: string) => classify(command) === 'deploy'

/** The words of a segment, past env assignments and `sudo`/`time`/`env`/`timeout N`. */
export function wordsOf(segment: string): string[] {
  return runWords(tokensOf(segment))
}

const unquote = (w: string) => w.replace(/^["']|["']$/g, '')

// ---------- git and gh ----------

/** The arguments of a gh/git subcommand that are not flags (and not the values of `valued` flags). */
function positional(words: string[], valued: RegExp): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w.startsWith('-')) {
      if (!w.includes('=') && valued.test(w)) i += 1
    } else out.push(unquote(w))
  }
  return out
}

const repoOf = (words: string[]) => {
  const i = words.findIndex(w => w === '-R' || w === '--repo')
  const eq = words.find(w => w.startsWith('--repo='))
  return i >= 0 ? unquote(words[i + 1] ?? '') || undefined : eq ? eq.slice(7) : undefined
}

/** `git push`: where it ran and which ref went out. Not a dry run, not a delete. */
export function pushOf(command: string): { dir?: string; ref?: string } | undefined {
  for (const seg of segmentsOf(command)) {
    const w = wordsOf(seg)
    if (w[0] !== 'git') continue
    let i = 1
    let dir: string | undefined
    while (i < w.length && w[i]!.startsWith('-')) {
      if (w[i] === '-C') {
        dir = unquote(w[i + 1] ?? '')
        i += 2
      } else i += /^-c$/.test(w[i]!) ? 2 : 1
    }
    if (w[i] !== 'push') continue
    const rest = w.slice(i + 1)
    if (rest.some(x => x === '--dry-run' || x === '-n' || x === '--delete' || x === '-d' || x.startsWith(':'))) return undefined
    const args = positional(rest, /^(?:-o|--push-option|--repo|--receive-pack|--exec)$/)
    const refspec = args[1]
    const ref = refspec ? refspec.replace(/^\+/, '').split(':')[0] || undefined : undefined
    return { dir, ref: ref === 'HEAD' ? undefined : ref }
  }
  return undefined
}

const GH_VALUED = /^(?:-R|--repo|-i|--interval|-q|--jq|-t|--template|--json|-r|--ref|-f|--raw-field|-F|--field|--json-input|-b|--body|--subject|-m|--match-head-commit|-A|--author-email)$/

function ghSub(command: string, sub: string, action: string): { args: string[]; words: string[] } | undefined {
  for (const seg of segmentsOf(command)) {
    const w = wordsOf(seg)
    if (w[0] === 'gh' && w[1] === sub && w[2] === action) {
      const words = w.slice(3)
      return { args: positional(words, GH_VALUED), words }
    }
  }
  return undefined
}

/** `gh pr checks [pr]`: the PR (number, URL or branch; none means the current branch's). */
export function prChecksOf(command: string): { pr?: string; repo?: string } | undefined {
  const m = ghSub(command, 'pr', 'checks')
  return m && { pr: m.args[0], repo: repoOf(m.words) }
}

/** `gh pr merge [pr]`, unless it only enables auto-merge. */
export function prMergeOf(command: string): { pr?: string; repo?: string } | undefined {
  const m = ghSub(command, 'pr', 'merge')
  if (!m || m.words.includes('--auto') || m.words.includes('--disable-auto')) return undefined
  return { pr: m.args[0], repo: repoOf(m.words) }
}

/** `gh workflow run <workflow> [--ref x]`. */
export function workflowRunOf(command: string): { workflow: string; ref?: string; repo?: string } | undefined {
  const m = ghSub(command, 'workflow', 'run')
  if (!m || !m.args[0]) return undefined
  const r = m.words.findIndex(w => w === '-r' || w === '--ref')
  return { workflow: m.args[0], ref: r >= 0 ? unquote(m.words[r + 1] ?? '') : undefined, repo: repoOf(m.words) }
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
  let c = lines.find(x => !x.includes('<<') && classify(x) !== undefined) ?? lines[0] ?? ''
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
