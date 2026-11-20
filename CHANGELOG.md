# Changelog

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
