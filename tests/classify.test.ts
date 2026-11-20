import { expect, test } from 'claude-code/testing'

import { classify, emptyTally, feed, prChecksOf, prMergeOf, pushOf, workflowRunOf } from '../hooks/parse'

// Commands taken from real Claude Code sessions (paths shortened). 0.1.x counted
// every one of the "nothing" cases as a test run: a runner named in a heredoc, an
// inline script, a commit message, a status query, a syntax check.

const cases: [string, string | undefined][] = [
  // Tests and checks.
  ['uv run pytest -q -x -p no:cacheprovider 2>&1', 'tests'],
  ['AWS_LC_SYS_PREBUILT_NASM=1 cargo clippy --all-targets -- -D warnings 2>&1', 'tests'],
  ['timeout 300 npm run typecheck 2>&1', 'tests'],
  ['.venv-test/Scripts/python.exe -m pytest backend/tests/test_payments.py -q -k refund 2>&1', 'tests'],
  ['MSYS_NO_PATHCONV=1 timeout 590 docker compose -p proj -f compose.backend-test.yml run --rm -T backend-tests', 'tests'],
  [String.raw`.\deploy\Invoke-LocalCI.ps1 -E2E *>&1`, 'tests'],
  [String.raw`powershell -NoProfile -ExecutionPolicy Bypass -File deploy\Invoke-LocalCI.ps1 *> "C:\Users\x\ci.log"`, 'tests'],
  ['cmd /c "cargo clippy -p mobile-android --all-targets -- -D warnings 2>&1"', 'tests'],
  [
    'MSYS_NO_PATHCONV=1 docker run --rm --network n -v "$S/ci-src:/repo" -w /repo/backend \\\n -e TEST_DATABASE_URL=postgres://x \\\n rust:1-bookworm bash -c \'cargo test --locked workspace::tests -- --ignored 2>&1 | grep -A4 "assertion"\'',
    'tests',
  ],
  ['docker compose run --rm node sh -c "npx --no-install biome check src"', 'tests'],
  ['cd x && (cd core && uv run ruff check . && uv run pytest -q)', 'tests'],
  ['ssh host \'bash /opt/scripts/check-app.sh api < /dev/null\'', 'tests'],
  // Builds.
  ['docker build -f site/Dockerfile -t web:ci . 2>&1 | tail -30', 'build'],
  ['docker buildx build --platform linux/amd64 --load -t app:1 .', 'build'],
  ['timeout 1200 cargo build 2>&1', 'build'],
  ['cd x; (npm run build > log 2>&1); echo done', 'build'],
  ['timeout 600 npx vite build 2>&1', 'build'],
  ['powershell -NoProfile -ExecutionPolicy Bypass -File deploy/Build-PublicAssets.ps1 2>&1', 'build'],
  ['.\\gradlew.bat assembleRelease', 'build'],
  // Deploys.
  ["ssh prod-host 'app-release shop stopstart --set SHOP_RELEASE=fa2883 2>&1 | tail -30'", 'deploy'],
  ["ssh prod-host 'bash -s' <<'EOF'\napp-release api stopstart 2>&1 | tail -1\nEOF", 'deploy'],
  ['docker save web:1 | ssh prod-host docker load', 'deploy'],
  ['bash scripts/server-release.sh 917034e1d3dad49d5a3575ad2adace214f23d5f0 > /tmp/r.log 2>&1', 'deploy'],
  ['kubectl rollout status deploy/web', 'deploy'],
  ['helm upgrade --install web ./chart', 'deploy'],
  ['npx wrangler deploy', 'deploy'],
  ['tag=$(git rev-parse --short=12 HEAD) && docker build -t web:$tag . && docker save web:$tag | ssh h docker load', 'deploy'],
  // Nothing.
  ['npx tsc --version', undefined],
  ['bash -n deploy/release.sh', undefined],
  ["ssh prod-host 'app-release web status 2>&1 | tail -6'", undefined],
  ['git add -A && git commit -q -m "Release builds run R8: the signed bundle drops to 7.6 MB"', undefined],
  ["git commit -q -F - <<'EOF'\nMake the site immersive\n\nTests: pytest -v passes, npm run build ok\nEOF", undefined],
  ["cat > tests/test_member_access.py <<'PY'\nimport pytest\ndef test_x(): pass\nPY", undefined],
  ['node -e \'const fs=require("fs");const f="src/features/desk/DeskScreen.test.tsx"\'', undefined],
  ['uv run --no-project python -c "\nhtml=[\'<body style=\\"padding:20px\\">\']\nfor i,slug in enumerate([1]): build(i)\n"', undefined],
  ["py - <<'EOF'\np = r'D:\\x\\AccountWizard.tsx'\nprint('pytest')\nEOF", undefined],
  ['PW=$(cat "C:/x/e2e-admin-pw.txt"); curl -u a:$PW https://x', undefined],
  ['docker compose -p x exec -T postgres psql -U a -c "select 1"', undefined],
  ['docker compose up -d --build', undefined],
  ['docker run -d --name pg -e POSTGRES_PASSWORD=x postgres:18', undefined],
  ['rm -rf "$S/tsc" "$S/tr.js"; ls "$S"', undefined],
  ["gh pr create --title 'Release: docker build fix' --body 'cargo test passes'", undefined],
  ['npm ci && npm install', undefined],
  ['grep -rn "docker build" docs/*.md | head', undefined],
  [": pytest smoke", undefined],
]

test('commands from real sessions: what is a run and what is not', async () => {
  const wrong = cases.filter(([cmd, want]) => classify(cmd) !== want).map(([cmd, want]) => ({ cmd, want, got: classify(cmd) }))
  expect(wrong).toEqual([])
})

test('git and gh commands that start GitHub runs', async () => {
  expect(pushOf('git push -u origin feat/x')).toEqual({ dir: undefined, ref: 'feat/x' })
  expect(pushOf('git -C /d/app push')).toEqual({ dir: '/d/app', ref: undefined })
  expect(pushOf('git push --dry-run')).toBe(undefined)
  expect(pushOf('git push origin --delete old')).toBe(undefined)
  expect(pushOf('git commit -m "push it"')).toBe(undefined)
  expect(prChecksOf('gh pr checks 12 --watch -R acme/web')).toEqual({ pr: '12', repo: 'acme/web' })
  expect(prChecksOf('gh pr checks')).toEqual({ pr: undefined, repo: undefined })
  expect(prMergeOf('gh pr merge 70 --merge')).toEqual({ pr: '70', repo: undefined })
  expect(prMergeOf('gh pr merge 70 --auto --squash')).toBe(undefined)
  expect(workflowRunOf('gh workflow run deploy.yml --ref main -f env=prod')).toEqual({ workflow: 'deploy.yml', ref: 'main', repo: undefined })
})

test('builds show percentages: cargo crates, git, webpack', async () => {
  const cargo = feed(emptyTally(), '   Compiling serde v1.0.200\n   Compiling tokio v1.40.0\n')
  expect([cargo.framework, cargo.done, cargo.current]).toEqual(['rust', 2, 'Compiling tokio'])
  const tty = feed(emptyTally(), '    Building [=======>          ] 123/456: tokio, serde\n')
  expect([tty.done, tty.total]).toEqual([123, 456])
  const git = feed(emptyTally(), 'Receiving objects:  45% (123/273)\r')
  expect(feed(git, '\n').percent).toBe(45)
  const webpack = feed(emptyTally(), '<s> [webpack.Progress] 67% building 512/700 modules\n')
  expect(webpack.percent).toBe(67)
  // A docker build counts its steps, and a cargo build inside one does not reset them.
  const docker = feed(emptyTally(), '#8 [builder 3/7] RUN cargo build --release\n#8 12.3    Compiling serde v1.0.200\n')
  expect([docker.framework, docker.done, docker.total, docker.current]).toEqual(['steps', 3, 7, 'Compiling serde'])
})
