# CI Watch for Claude Code

[![CI](https://github.com/mateuszsury/claude-code-ci-watch/actions/workflows/ci.yml/badge.svg)](https://github.com/mateuszsury/claude-code-ci-watch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Live progress of tests, builds, deploys, GitHub Actions and PR checks beside the chat, and a watchdog that wakes the agent when one of them hangs.**

Claude Code often starts a test suite, builds an image or pushes to CI and then just waits. When the run hangs, a container stops printing or a GitHub job sits in the queue, nothing tells the agent, and the session quietly stalls. CI Watch is a Claude Code mod that:

- shows every long run of the session in a pane, live: `24/245 · 10% · tests/test_api.py::test_login`, a progress bar, ✓/✗/○ counts, ETA, the last failures;
- finds the GitHub Actions runs your `git push`, `gh pr merge` or `gh workflow run` started, and the checks of a PR, and follows them job by job;
- watches for silence and wakes the agent with a concrete message when a run stalls, and when CI finishes;
- gives the agent a `status` tool, so it checks progress instead of sleeping or re-reading log files.

```
╭──────────────────────────────────────────────╮
│ ● Running · pytest                     02:14 │
│ pytest -v tests/                             │
│ tests/test_api.py::test_login ███░░  24/245 · 10% │
│ ✓ 22   ✗ 2   ○ 0   ETA 3:40                  │
│ ▸ tests/test_api.py::test_login              │
│ ✗ tests/test_api.py::test_refund             │
│ [ Notify agent ] [ Stop tracking ]           │
╰──────────────────────────────────────────────╯
╭──────────────────────────────────────────────╮
│ ● Running · build                      01:02 │
│ docker build -t web:1 .                      │
│ RUN npm ci            ██████░░░░  4/7 · 57%   │
╰──────────────────────────────────────────────╯
╭──────────────────────────────────────────────╮
│ ✗ Failed · GitHub Actions              06:02 │
│ CI · fix login redirect                      │
│ ✓ lint                                   4/4 │
│ ✗ e2e › Run playwright                   6/6 │
│ Open on GitHub  [ Remove ]                   │
╰──────────────────────────────────────────────╯
```

When the pane is minimized it shows one line (`● 24/245 · 10% ✗ 2` and the current test), and the status line shows `🧪 24/245 · 10% · test_name` (🔨 for a build, 🚀 for a deploy, ⚙ for CI).

## Install

CI Watch needs a Claude Code build with mods (function hooks): 2.1.326 or newer. The mod API is early access and may change between releases.

At the prompt of a Claude Code terminal session:

```
/plugin install ci-watch --marketplace mateuszsury/claude-code-ci-watch
```

Answer `y` to add the marketplace, then pick the **user** scope so it loads in every session.

From a shell:

```
claude plugin install ci-watch --marketplace mateuszsury/claude-code-ci-watch
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `mateuszsury/claude-code-ci-watch`, then **Add plugin**.

For GitHub Actions and PR checks, the [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and signed in. The mod calls only `gh run list`, `gh run view`, `gh pr checks` and `gh pr view`; it never reruns, cancels or changes anything.

## One session at a time

Installed at the user scope, the mod is on in every session, but each session sees only its own runs. Runs live in the session's own state, the hooks run in that session's process, and the watchdog wakes only that session's agent. Nothing is written to cross-session storage, so two sessions running tests side by side never mix their panels or wake each other.

## What it tracks

### Commands the agent runs

Every Bash or PowerShell command is read the way a shell reads it: quotes, `$(…)`, line continuations, heredocs, `&&`/`;`/`|` chains. Wrappers are looked through (`bash -c`, `ssh host …`, `powershell -File`, `cmd /c`, `uv run`, `npx`, `docker run|exec`, `docker compose run|exec`), and only what actually runs decides. A runner named in a path, a commit message, an inline script (`node -e`, `python -c`), a heredoc body or a `--version` query never counts.

| Category | Examples | Stall limit |
| --- | --- | --- |
| **Tests and checks** | pytest, jest, vitest, playwright test, mocha, `go test`, `cargo test/clippy/check`, `dotnet test`, gradle/mvn test, tsc, eslint, ruff, mypy, `npm run test/lint/typecheck`, `make test`, `act`, `docker compose up --abort-on-container-exit`, tests inside `docker run`/`compose run`, scripts named `ci`, `e2e`, `check`, `test`… | 5 min |
| **Builds** | `docker build`, `docker buildx build`, `docker compose build`, `cargo build`, `go build`, `dotnet build/publish`, `npm run build`, `vite/next build`, gradle assemble, `cmake --build`, scripts named `build`… | 10 min |
| **Deploys** | `docker push`, `docker save … \| ssh … docker load`, `kubectl apply/rollout`, `helm upgrade`, `terraform apply`, `pulumi up`, `fly/vercel/netlify/wrangler/firebase deploy`, `npm publish`, scripts and tools named `deploy`, `release`, `rollout` (also over `ssh`), but not their `status`/`logs` queries | 20 min |

- A command run in the **background** is followed live: its output file is read every 2 s.
- A command in the **foreground** gets a card only once it has run for 10 s, so quick checks never open the pane; it shows its result when it ends.
- A command moved to the background after its timeout is followed live from then on.
- `/ci <log path>` or the agent's `track` tool follows any other log file.

### GitHub Actions and PR checks

| What happens | What CI Watch does |
| --- | --- |
| `git push` to a GitHub remote | reads the branch and the new commit from git's output, then looks for the runs of that commit a few times over the next 2 minutes (`gh run list --branch … `) and tracks each one |
| `gh pr merge` | looks up the merge commit and tracks the runs it started (deploys on `main` usually start here) |
| `gh workflow run <workflow>` | tracks the dispatched run |
| `gh run watch|view|rerun <id>`, a run URL | tracks that run |
| `gh pr checks [pr]` | tracks the PR's checks, from any CI provider that reports to GitHub |
| `/ci <run id>`, `/ci pr [number]`, the `track` tool | tracks by hand |

Runs are polled every 15 s (`gh run view --json`). The card lists the jobs with their current step and step counts, and links to the run. All the runs one push started are one group: the agent hears about them once, when the last one ends (`GitHub Actions for the push of 6fb617a finished: ❌ 1 of 3 failed`, with each job and the URLs).

### Output it understands

| Runner | What it reads |
| --- | --- |
| pytest | `collected N items`, verbose `PASSED/FAILED/SKIPPED/ERROR` lines, quiet `..F.s [ 40%]` lines, xdist, the `FAILED` short summary, the final summary |
| Playwright | `Running N tests`, list reporter (`✓ ✘ -`), line reporter (`[24/245]`), failure headers, final counts |
| Vitest, Jest, Mocha | per-file and per-test lines, failure headers, final `Tests:` lines |
| Go, Cargo, .NET | `--- PASS/FAIL`, `test x ... ok`, `Passed/Failed name [ms]` and per-assembly summaries |
| tsc, eslint | each `error TS…` line, `✖ N problems (M errors…)` |
| Builds | `[n/m]` step counters (docker build `#8 [builder 3/7] RUN …`, turbo), cargo `Compiling crate` and `Building [==>] n/m`, and any printed percentage (git `Receiving objects: 45%`, webpack, gradle, pip) |

Docker, compose, `act` and GitHub Actions log prefixes (`tests-1  | `, `#7 0.322 `, `[CI/test]   | `, timestamps) are stripped, so tests inside a container count exactly like local ones. When nothing is recognised, the card still shows the elapsed time, the silence and the last output line.

## The watchdog

| Situation | Default | What happens |
| --- | --- | --- |
| Background tests print nothing | 5 min | the card turns amber (Stalled), a toast and a desktop notification, and the agent is told |
| A background build prints nothing | 10 min | same |
| A background deploy prints nothing | 20 min | same (image transfers are often quiet) |
| A GitHub run or PR checks are queued | 10 min | same, "probably no runner is available or the workflow is blocked" |
| A GitHub run's jobs and steps, or a PR's checks, stop changing | 20 min | same |
| Tracked GitHub runs or PR checks finish | at once | the agent gets the verdict, the failed jobs and the URLs, once per push |

How the agent is told depends on what it is doing:

- **idle** (it ended its turn to wait): a new prompt starts a turn;
- **stuck in a blocking wait** (`gh run watch`, `gh pr checks --watch`, `sleep`, a `while … sleep` loop): the wait is ended and the prompt follows;
- **busy with other work**: a note is added that the agent reads with its next step.

Each message starts with `[ci-watch]`, describes the run and asks the agent to find the cause and act instead of waiting again. One alert is sent per silence: new output resets it. The **Notify agent** button on a card sends the same description on demand.

## Options

Set them in the config menu (`/config`, the **ci-watch** rows) or in `settings.json` under `pluginConfigs`:

| Option | Default | |
| --- | --- | --- |
| `testStallMinutes` | 5 | silence before background tests count as stalled |
| `buildStallMinutes` | 10 | the same for builds |
| `deployStallMinutes` | 20 | the same for deploys |
| `ciStallMinutes` | 20 | a GitHub run or PR checks with no change |
| `queueStallMinutes` | 10 | a GitHub run or PR checks still queued |
| `autoTrackGitHub` | true | find and track the runs after `git push`, `gh pr merge`, `gh workflow run` |
| `wakeOnCiFinish` | true | tell the agent when tracked GitHub runs and PR checks end |

The agent can also pass `stall_minutes` to `track` for one run that is quiet by design.

## Commands and tools

| | |
| --- | --- |
| `/ci` | open the pane |
| `/ci <run id or run URL>` | track a GitHub Actions run |
| `/ci pr [number or URL]` | track a PR's checks (the current branch's without a number) |
| `/ci <path>` | track a log file |
| `/ci clear` | remove finished runs |
| `mcp__ci-watch__status` | the agent's view of every run in the session: progress, current test, failures, silence, jobs, checks |
| `mcp__ci-watch__track` | `{ gh_run_id \| pr \| log_path, repo, label, stall_minutes, notify_on_finish }` |

The plugin also ships a `ci-watch` skill that tells the agent how to run tests so the pane can read them (background, unbuffered, one line per test), how to wait (the status tool, not `sleep`) and what to do with a `[ci-watch]` message. If your project's instructions forbid polling CI in a repository, the skill tells the agent to respect that; set `autoTrackGitHub` to false to stop the mod from looking up runs by itself.

## How it works

The mod is a hooks module (`hooks/register.tsx`) loaded by Claude Code:

- a `tool.call` hook sees each Bash/PowerShell command and classifies it (`hooks/parse.ts`); for a run in the background it reads the output file path from the tool result;
- a timer reads new bytes of each output file every 2 s and feeds them to the parser, which keeps a running tally;
- a `session.append` hook catches the `<task-notification>` that ends a background command and records the exit code; failures in the output win over a swallowed exit code (`pytest || true`);
- after `git push`, `gh pr merge` and `gh workflow run` it looks up the runs they started; runs and PR checks are polled with `gh … --json` and mapped to cards (`hooks/github.ts`);
- `turn.start` and `turn.complete` hooks track whether the agent is idle, which decides how a message is delivered;
- a `ui.render` hook draws the pane on every surface (terminal, desktop, VS Code, mobile).

## Development

```
claude plugin validate .
claude plugin test .
```

The tests cover the command classifier on commands taken from real sessions (including the false positives earlier versions had), the output parsers on real runner output (including docker compose and buildkit), the mapping of real `gh` JSON, the pane on all four surfaces, and the watchdog and GitHub flows with a mocked clock and a fake `gh`: a run that goes quiet wakes the idle agent exactly once, the workflows of one push are reported together, a quick foreground check gets no card. CI runs the same two commands on every push.

To work on a copy in a session, load the folder with `claude --plugin-dir <folder>`.

## Limitations

- Foreground commands show their result only when they end; run long suites in the background.
- Buffered output looks like silence. Use unbuffered flags (`PYTHONUNBUFFERED=1`, `--reporter=line`), or raise the stall limit.
- Test-level progress inside a running GitHub job is not available from the API; jobs, steps and checks are.
- Runs are found after a push only for GitHub remotes, and only while `gh` can see the repository.
- The mod API is early access; a future Claude Code release may need an update of this plugin.

## License

[MIT](LICENSE)
