# CI Watch for Claude Code

**Live test and CI progress beside the chat, and a watchdog that wakes the agent when CI hangs.**

Claude Code often starts a test suite or pushes to CI and then just waits. When the run hangs, a container stops printing or a GitHub job sits in the queue, nothing tells the agent, and the session quietly stalls. CI Watch is a Claude Code mod that:

- shows every test run of the session in a pane, live: `24/245 · tests/test_api.py::test_login`, a progress bar, ✓/✗/○ counts, ETA, the last failures;
- watches for silence and wakes the agent with a concrete message when a run stalls, and when a GitHub Actions run finishes;
- gives the agent a `status` tool, so it checks progress instead of sleeping or re-reading log files.

```
╭──────────────────────────────────────────────╮
│ ● Running · pytest                     02:14 │
│ pytest -v tests/                             │
│ tests/test_api.py::test_login ███░░  24/245  │
│ ✓ 22   ✗ 2   ○ 0   ETA 3:40                  │
│ ▸ tests/test_api.py::test_login              │
│                                              │
│ ✗ tests/test_api.py::test_refund             │
│ ✗ tests/test_api.py::test_delete             │
│ [ Notify agent ] [ Stop tracking ]           │
╰──────────────────────────────────────────────╯
╭──────────────────────────────────────────────╮
│ ✗ Failed · GitHub Actions              06:02 │
│ CI · fix login redirect                      │
│ ✓ lint                                   4/4 │
│ ✗ e2e › Run playwright                   6/6 │
│ Open on GitHub  [ Remove ]                   │
╰──────────────────────────────────────────────╯
```

When the pane is minimized it shows one line (`● 24/245 ✗ 2` and the current test), and the status line shows `🧪 24/245 · test_name`.

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

For GitHub Actions tracking, the [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and signed in.

## One session at a time

Installed at the user scope, the mod is on in every session, but each session sees only its own runs. Runs live in the session's own state, the hooks run in that session's process, and the watchdog wakes only that session's agent. Nothing is written to cross-session storage, so two sessions running tests side by side never mix their panels or wake each other.

## What it tracks

Nothing to configure for the common cases:

| Source | How it is picked up | Live? |
| --- | --- | --- |
| A test command run with Bash/PowerShell `run_in_background` | the command looks like tests or CI (pytest, jest, vitest, playwright, cypress, go test, cargo test, dotnet test, mvn/gradle, npm/pnpm/yarn `test`/`e2e`/`ci`/`lint`/`build`, tsc, eslint, make test, act, docker build/run, docker compose up, CI scripts) | yes: the output file is read every 2 s |
| A foreground test command | same detection | result when it ends |
| A command moved to the background after its timeout | the tool result names the task | yes, from then on |
| `gh run watch <id>`, `gh run view <id>`, a run URL | the command names the run | yes: `gh run view` every 15 s |
| `docker compose logs -f <test-service>` | the service name has `test`, `e2e` or `ci` in it | yes |
| Anything else | `/ci <run id or URL or log path>`, or the agent's `track` tool | yes |

### Runners it understands

| Runner | What it reads |
| --- | --- |
| pytest | `collected N items`, verbose `PASSED/FAILED/SKIPPED/ERROR` lines, quiet `..F.s [ 40%]` lines, xdist `[gw0]` lines, `FAILED` short summary, the final summary |
| Playwright | `Running N tests`, list reporter (`✓ ✘ -`), line reporter (`[24/245]`), failure headers, final counts |
| Vitest | per-file lines `(12 tests \| 2 failed)`, verbose per-test lines, `Tests 2 failed \| 243 passed (245)` |
| Jest | `PASS/FAIL file`, `--verbose` check marks, `●` failure headers, `Tests: … total` |
| Mocha | check marks, numbered failures, `N passing` |
| Go | `=== RUN`, `--- PASS/FAIL/SKIP` |
| Cargo | `running N tests`, `test x ... ok/FAILED/ignored` |
| .NET | `Passed/Failed/Skipped name [ms]`, per-assembly `Failed!/Passed!` summaries |
| tsc, eslint | each `error TS…` line, `✖ N problems (M errors…)` |
| Anything with `[n/m]` | docker build steps (`#8 [builder 3/7] RUN …`), turbo and similar |

When nothing is recognised, the card still shows the elapsed time, the silence and the last output line.

### Tests in Docker

Docker and compose put their own prefix in front of each line (`tests-1  | `, `#7 0.322 `), and so do `act` (`[CI/test]   | `) and GitHub Actions logs (timestamps, `job<TAB>step<TAB>`). CI Watch strips them, so a test suite inside a container counts exactly like a local one. Two things keep it live:

- run the stack attached, in the background: `docker compose up --abort-on-container-exit --exit-code-from tests` or `docker compose run --rm tests pytest -v`, not `up -d`;
- set `PYTHONUNBUFFERED=1` for Python in a container, which buffers output without a TTY.

## The watchdog

| Situation | When | What happens |
| --- | --- | --- |
| A background run prints nothing | 5 min | the card turns amber (Stalled), a toast and a desktop notification, and the agent is told |
| A GitHub run is queued | 10 min | same, "probably no runner is available or the workflow is blocked" |
| A GitHub run's jobs and steps stop changing | 20 min | same |
| A GitHub run finishes | at once | the agent gets the verdict, the failed jobs and the URL |

How the agent is told depends on what it is doing:

- **idle** (it ended its turn to wait): a new prompt starts a turn;
- **stuck in a blocking wait** (`gh run watch`, `sleep`, a `while … sleep` loop): the wait is ended and the prompt follows;
- **busy with other work**: a note is added that the agent reads with its next step.

Each message starts with `[ci-watch]`, describes the run (progress, current test, failures, silence, log path) and asks the agent to find the cause and act instead of waiting again. One alert is sent per silence: new output resets it. The **Notify agent** button on a card sends the same description on demand.

The limits are defaults; the agent can pass `stall_minutes` to `track` for a run that is quiet by design.

## Commands and tools

| | |
| --- | --- |
| `/ci` | open the pane |
| `/ci <run id or run URL>` | track a GitHub Actions run |
| `/ci <path>` | track a log file |
| `/ci clear` | remove finished runs |
| `mcp__ci-watch__status` | the agent's view of every run in the session: progress, current test, failures, silence, jobs |
| `mcp__ci-watch__track` | `{ gh_run_id, repo, log_path, label, stall_minutes, notify_on_finish }` |

The plugin also ships a `ci-watch` skill that tells the agent how to run tests so the pane can read them (background, unbuffered, one line per test), how to wait (status tool, not `sleep`) and what to do with a `[ci-watch]` message. If your project's instructions forbid polling CI in a repository (for example a private repository with no Actions minutes), the skill tells the agent to respect that.

## How it works

The mod is a hooks module (`hooks/register.tsx`) loaded by Claude Code:

- a `tool.call` hook sees each Bash/PowerShell command; for a test command run in the background it reads the output file path from the tool result and starts a run;
- a timer reads new bytes of each output file every 2 s and feeds them to the parser (`hooks/parse.ts`), which keeps a running tally;
- a `session.append` hook catches the `<task-notification>` that ends a background command and records the exit code; failures in the output win over a swallowed exit code (`pytest || true`);
- GitHub runs are polled with `gh run view --json`;
- `turn.start` and `turn.complete` hooks track whether the agent is idle, which decides how a stall message is delivered;
- a `ui.render` hook draws the pane on every surface (terminal, desktop, VS Code, mobile).

## Development

```
claude plugin validate .
claude plugin test .
```

The tests cover the parsers on real runner output (including output captured from docker compose and buildkit), the pane on all four surfaces, and the watchdog with a mocked clock: a run that goes quiet wakes the idle agent exactly once, and a task notification ends the run with its exit code.

To work on a copy in a session, load the folder with `claude --plugin-dir <folder>`.

## Limitations

- Foreground commands show their result only when they end; run long suites in the background.
- Buffered output looks like silence. Use the unbuffered flags above, or raise `stall_minutes`.
- Test-level progress inside a running GitHub job is not available from the API; jobs and steps are.
- The mod API is early access; a future Claude Code release may need an update of this plugin.

## License

[MIT](LICENSE)
