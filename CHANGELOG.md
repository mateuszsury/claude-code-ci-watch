# Changelog

## 0.2.0 (2026-11-20)

- **GitHub runs found by themselves**: after `git push` to GitHub, `gh pr merge` and `gh workflow run`, the runs they started are looked up and tracked. All the runs of one push are one group, and the agent hears once, when the last one ends.
- **PR checks**: `gh pr checks [pr]`, `/ci pr [n]` and `track { pr }` follow a pull request's checks from any CI that reports to GitHub, with a message when they end.
- **Builds and deploys** are categories of their own, each with its own stall limit (10 and 20 min): `docker build`, `cargo build`, `npm run build`…, and `docker push/save`, `kubectl`, `helm`, `terraform`, cloud CLIs, deploy and release scripts (also over `ssh`), but not their `status`/`logs` queries.
- **Percentages**: cards, the minimized pane and the status line show `4/7 · 57%`; builds that print no count use the last percentage they print (git, webpack, gradle, pip) and cargo's crate count.
- **Far fewer false runs**: commands are read like a shell reads them (quotes, escapes, `$(…)`, line continuations, heredocs) and wrappers are looked through, so a runner named in a path, a commit message, an inline script (`node -e`, `python -c`), a heredoc body, a `--version` query or `bash -n` no longer counts; `npm ci` is an install, not CI. Checked against 26,000 commands from real sessions.
- **Quick foreground commands** get no card: a card appears only after 10 s.
- **Options** in the config menu: stall limits for tests, builds, deploys, CI and queues; `autoTrackGitHub`; `wakeOnCiFinish`.
- A GitHub Actions workflow runs `claude plugin validate` and `claude plugin test` on every push.

## 0.1.1 (2026-11-20)

- A runner named inside a path or file name (`rm -rf $DIR/tsc`, `cat pytest.ini`) no longer starts a run. Commands that only read, search, move or commit files (`git`, `cat`, `grep`, `rm`, ...) are never test runs.
- `docker compose -f <file> run|build` is detected like `docker compose run|build`.

## 0.1.0 (2026-11-20)

First release.

- Live **Tests & CI** pane: per-run cards with a progress bar (`24/245`), the current test, ✓/✗/○ counts, ETA, elapsed and silent time, the last failures, and GitHub Actions jobs with their current step. A one-line glance when the pane is minimized, and a status-line entry.
- Parsers for pytest (verbose, quiet, xdist), Playwright (list, line), Vitest, Jest, Mocha, `go test`, `cargo test`, `dotnet test`, tsc, eslint, and generic `[n/m]` step counters (docker build, turbo).
- Docker, docker compose, `act` and GitHub Actions log prefixes are stripped, so tests inside containers count like local ones.
- Automatic tracking of background Bash/PowerShell test commands, foreground test commands (result at the end), `gh run watch|view <id>` and GitHub run URLs.
- Stall watchdog: wakes the agent when a background run prints nothing for 5 min, a GitHub run is queued for 10 min or stops changing for 20 min; ends a blocking `gh run watch`/`sleep` wait; reports finished GitHub runs.
- Tools `mcp__ci-watch__status` and `mcp__ci-watch__track`, the `/ci` command, and the `ci-watch` skill.
