import { expect, test } from 'claude-code/testing'

import { emptyTally, feed, flush, ghRunOf, isTestCommand, isWaitCommand, labelOf, outputPathOf, taskEndOf } from '../hooks/parse'

const run = (...chunks: string[]) => flush(chunks.reduce((t, c) => feed(t, c), emptyTally()))

test('pytest -v: counts each test, names the current one, ends on the summary', async () => {
  const t = run(
    '============ test session starts ============\ncollected 5 items\n\n',
    'tests/test_api.py::test_login PASSED                 [ 20%]\n',
    'tests/test_api.py::test_logout FAILED                [ 40%]\n',
    'tests/test_api.py::test_ref',
    'und SKIPPED (no stripe)  [ 60%]\n',
  )
  expect(t.framework).toBe('pytest')
  expect([t.done, t.total, t.passed, t.failed, t.skipped]).toEqual([3, 5, 1, 1, 1])
  expect(t.current).toBe('tests/test_api.py::test_refund')
  expect(t.failures).toEqual(['tests/test_api.py::test_logout'])

  const end = feed(t, '=========== 1 failed, 3 passed, 1 skipped in 2.31s ===========\n')
  expect([end.done, end.passed, end.failed, end.skipped]).toEqual([5, 3, 1, 1])
})

test('pytest quiet dots count by character', async () => {
  const t = run('collected 12 items\n\ntests/test_a.py ....F.s.  [ 66%]\ntests/test_b.py ..E.\x1b[32m [100%]\x1b[0m\n')
  expect([t.done, t.passed, t.failed, t.skipped]).toEqual([12, 9, 2, 1])
  expect(t.current).toBe('tests/test_b.py')
})

test('playwright list and line reporters', async () => {
  const list = run(
    'Running 245 tests using 8 workers\n',
    '  ✓  1 [chromium] › tests/login.spec.ts:12:5 › logs in (1.2s)\n',
    '  ✘  2 [chromium] › tests/pay.spec.ts:30:5 › pays (5.0s)\n',
    '  -  3 [chromium] › tests/skip.spec.ts:3:5 › skipped\n',
  )
  expect([list.done, list.total, list.passed, list.failed, list.skipped]).toEqual([3, 245, 1, 1, 1])
  expect(list.failures).toEqual(['[chromium] › tests/pay.spec.ts:30:5 › pays'])

  const line = run('Running 245 tests using 8 workers\n[24/245] [chromium] › tests/a.spec.ts:3:1 › opens the panel\n')
  expect([line.done, line.total]).toEqual([24, 245])
  expect(line.current).toBe('[chromium] › tests/a.spec.ts:3:1 › opens the panel')
})

test('vitest file lines, then the final Tests line', async () => {
  const t = run(
    ' ✓ src/a.test.ts (12 tests) 34ms\n',
    ' ❯ src/b.test.ts (5 tests | 2 failed) 20ms\n',
    ' Test Files  1 failed | 1 passed (2)\n      Tests  2 failed | 15 passed (17)\n',
  )
  expect(t.framework).toBe('vitest')
  expect([t.done, t.total, t.passed, t.failed]).toEqual([17, 17, 15, 2])
})

test('jest verbose lines and summary', async () => {
  const t = run(
    'PASS src/math.test.js\n  math\n    ✓ adds (3 ms)\n    ✕ divides (2 ms)\n    ○ skipped later\n',
    '  ● math › divides\n',
    'Tests:       1 failed, 1 skipped, 1 passed, 3 total\n',
  )
  expect(t.framework).toBe('jest')
  expect([t.done, t.total, t.passed, t.failed, t.skipped]).toEqual([3, 3, 1, 1, 1])
  expect(t.failures).toContain('math › divides')
})

test('go test and cargo test', async () => {
  const go = run('=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.01s)\n')
  expect([go.framework, go.passed, go.failed]).toEqual(['go', 1, 1])
  const cargo = run('running 3 tests\ntest a::x ... ok\ntest a::y ... FAILED\ntest a::z ... ignored\n')
  expect([cargo.framework, cargo.done, cargo.total, cargo.failed, cargo.skipped]).toEqual(['cargo', 3, 3, 1, 1])
})

test('dotnet summaries add up across assemblies', async () => {
  const t = run(
    '  Failed Api.Tests.Pays [12 ms]\n',
    'Failed!  - Failed:     1, Passed:   10, Skipped:     0, Total:    11, Duration: 2 s - Api.Tests.dll\n',
    'Passed!  - Failed:     0, Passed:    5, Skipped:     1, Total:     6, Duration: 1 s - Core.Tests.dll\n',
  )
  expect([t.framework, t.passed, t.failed, t.skipped, t.done]).toEqual(['dotnet', 15, 1, 1, 17])
  expect(t.failures).toEqual(['Api.Tests.Pays'])
})

test('docker build steps use the generic counter', async () => {
  const t = run('#5 [builder 2/7] COPY package.json .\n#8 [builder 4/7] RUN npm ci\n')
  expect([t.framework, t.done, t.total, t.current]).toEqual(['steps', 4, 7, 'RUN npm ci'])
})

// Captured from docker compose 2 / buildkit on Docker 29 (the probe ran fake pytest lines in alpine).
test('pytest inside docker compose up: the service prefix is stripped', async () => {
  const t = run(
    'tests-1  | collected 3 items\n',
    'tests-1  | tests/test_d.py::test_a PASSED  [ 33%]\n',
    'tests-1  | tests/test_d.py::test_b FAILED  [ 66%]\n',
    '\x1b[Ktests-1 exited with code 0\n',
  )
  expect([t.framework, t.done, t.total, t.failed]).toEqual(['pytest', 2, 3, 1])
  expect(t.failures).toEqual(['tests/test_d.py::test_b'])
})

test('pytest in a docker build RUN step: build steps, then the tests take over', async () => {
  const t = run(
    '#6 [2/3] COPY fake.sh /fake.sh\n#7 [3/3] RUN sh /fake.sh\n',
    '#7 0.322 collected 3 items\n#7 0.322 tests/test_d.py::test_a PASSED  [ 33%]\n',
  )
  expect([t.framework, t.done, t.total, t.current]).toEqual(['pytest', 1, 3, 'tests/test_d.py::test_a'])
})

test('act and GitHub Actions log prefixes', async () => {
  const act = run('[CI/test]   | Running 2 tests using 1 worker\n[CI/test]   |   ✓  1 [chromium] › a.spec.ts:3:1 › opens (1.1s)\n')
  expect([act.framework, act.done, act.total]).toEqual(['playwright', 1, 2])
  const gh = run('test\tRun pytest\t2026-11-20T10:00:01.1234567Z tests/x.py::test_q FAILED  [ 50%]\n')
  expect(gh.failures).toEqual(['tests/x.py::test_q'])
})

test('tsc errors become failures', async () => {
  const t = run("src/a.ts(3,7): error TS2322: Type 'x' is not assignable\nsrc/b.ts:9:1 - error TS2304: Cannot find name 'y'.\n")
  expect([t.framework, t.failed]).toEqual(['tsc', 2])
})

test('commands: which are tests, waits, GitHub runs', async () => {
  expect(isTestCommand('cd /d/app && PYTHONUNBUFFERED=1 pytest -v tests/')).toBe(true)
  expect(isTestCommand('npx playwright test --workers=8')).toBe(true)
  expect(isTestCommand('docker compose -f ci.yml up --abort-on-container-exit')).toBe(true)
  expect(isTestCommand('git status')).toBe(false)
  expect(isTestCommand('docker compose -f ci.yml logs -f --no-log-prefix tests')).toBe(true)
  expect(isTestCommand('docker compose logs -f web')).toBe(false)
  expect(isWaitCommand('gh run watch 1234567 --exit-status')).toBe(true)
  expect(isWaitCommand('sleep 300')).toBe(true)
  expect(isWaitCommand('pytest')).toBe(false)
  expect(ghRunOf('gh run watch 9876543 -R acme/web --exit-status')).toEqual({ runId: '9876543', repo: 'acme/web' })
  expect(ghRunOf('open https://github.com/acme/web/actions/runs/123456789/job/1')).toEqual({ runId: '123456789', repo: 'acme/web' })
  expect(labelOf('cd /d/app && CI=1 npm run test:e2e 2>&1')).toBe('npm run test:e2e')
  expect(labelOf("cat > x.sh <<'EOF'\necho hi\nEOF\ncd /d/app && pytest -v tests/")).toBe('pytest -v tests/')
})

// 0.1.0 tracked `rm -rf "$S/tsc"` as a test run: a runner's name inside a path counted.
test('commands that only mention a runner are not test runs', async () => {
  for (const cmd of [
    'rm -rf "$S/tsc" "$S/tr.js"; ls "$S"',
    'cat pytest.ini',
    "git commit -m 'fix jest config'",
    'grep -rn pytest src/ | head',
    'code tests/playwright.config.ts',
    'ls node_modules/.bin/vitest',
  ]) {
    expect([cmd, isTestCommand(cmd)]).toEqual([cmd, false])
  }
  for (const cmd of [
    './gradlew test',
    'uv run pytest -q',
    'timeout 600 npx playwright test',
    'bash -c "cd app && pytest -v"',
    'echo start; pytest -v; echo done',
    'CI=1 npm test',
    './scripts/ci.sh',
    'docker compose -f ci.yml run --rm tests',
  ]) {
    expect([cmd, isTestCommand(cmd)]).toEqual([cmd, true])
  }
})

test('background output path and task notifications', async () => {
  const text =
    'Command running in background with ID: bmanz9mj3. Output is being written to: C:\\Temp\\tasks\\bmanz9mj3.output. You will be notified when it completes'
  expect(outputPathOf(text)).toBe('C:\\Temp\\tasks\\bmanz9mj3.output')
  const note =
    '<task-notification>\n<task-id>bmanz9mj3</task-id>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 1)</summary>\n</task-notification>'
  expect(taskEndOf(note)).toEqual({ taskId: 'bmanz9mj3', status: 'completed', exitCode: 1 })
  expect(taskEndOf('hello')).toBe(undefined)
})
