---
name: ci-watch
description: How to run tests, builds, deploys and CI so the ci-watch panel shows live progress (24/245 test_name, 4/7 · 57%), and how to react when it reports a stall or finished GitHub Actions / PR checks. Use whenever you run a test suite, e2e, lint/typecheck, a local CI script, a docker build or compose test stack, a deploy or release, push to GitHub, merge a PR or wait for GitHub Actions; and whenever a message starting with "[ci-watch]" arrives.
---

# ci-watch: live tests, builds, deploys and CI

The `ci-watch` mod shows a panel beside the chat with live progress of tests (for example `24/245 · 10% · tests/test_api.py::test_login`), builds (`4/7 · 57%`), deploys, GitHub Actions runs and PR checks, with failures and stalls. It reads only what reaches a command's output, so run things in a way it can read. It tracks only the runs of the session it runs in.

## Running tests, builds and deploys

- Run anything that may take more than about a minute (a full suite, e2e, local CI, `docker build`, a compose test stack, a deploy or release script) with Bash `run_in_background: true`. The mod attaches by itself. A foreground command gets a card only after 10 s and shows its result only when it ends.
- Make the output unbuffered and print one line per test, or the counter stands still:
  - pytest: `PYTHONUNBUFFERED=1 pytest -v` (with xdist too);
  - Playwright: `--reporter=line` or `list`;
  - Vitest: `--reporter=verbose`; Jest: `--verbose`;
  - Go: `go test -v ./...`; .NET: `dotnet test --logger "console;verbosity=normal"`;
  - Docker: `docker build --progress=plain`.
- Several CI steps in one script: one background command, output to the console (not redirected to a file). If you must write your own log file, register it: `mcp__ci-watch__track { log_path, label }`.

## Tests in Docker

The mod strips the prefixes docker, compose and `act` add (`tests-1  | `, `#7 0.322 `, `[CI/job]   | `), so tests inside a container count like local ones, as long as the container's output reaches the background command.

- Run a test stack attached, in a background Bash command: `docker compose -f <file> up --abort-on-container-exit --exit-code-from <test-service>`, or `docker compose run --rm <service> <test command>`. The tests' exit code becomes the command's. Clean up in the same command: `...; docker compose -f <file> down -v`.
- Do not start tests with `up -d` and nothing after it: the output disappears into Docker. If the stack must run detached, follow the test container's logs in the background: `docker compose logs -f --no-log-prefix <test-service>` (a service name with "test", "e2e" or "ci" in it).
- Python in a container buffers its output without a TTY. Set `PYTHONUNBUFFERED=1` (`-e`, or `environment:` in compose), or progress arrives in chunks and the mod reports a false stall.
- Tests in a Dockerfile `RUN` step: `docker build --progress=plain`. The mod shows build steps (`[3/8]`), then the test count of that step.
- Run a GitHub workflow locally with `act` in the background too.

## Waiting

- Do not use `sleep`, loops with `sleep`, or read the output file by hand to check progress. A background command sends a `<task-notification>` when it ends; `mcp__ci-watch__status` gives the live state.
- While long tests run, do other work, or end your turn and tell the user what is running. The mod wakes you if something stalls.

## GitHub Actions

The project's rules come first: if CLAUDE.md forbids checking or polling CI in a repository (for example a private repository with no Actions minutes), run the steps locally and do not wait for Actions there.

The mod finds the runs by itself, so you do not need to look them up:
- after `git push` to GitHub it tracks the runs of the pushed commit (they appear within a minute or two);
- after `gh pr merge` it tracks the runs of the merge commit (often the deploy);
- after `gh workflow run <workflow>` it tracks the dispatched run;
- `gh pr checks [pr]` tracks the PR's checks, from any CI that reports to GitHub (Vercel, Netlify, external CI too).

Then:
1. Do not wait in the foreground (`gh run watch`, `gh pr checks --watch`, `sleep`). Do other work, or end your turn and tell the user CI is running. The mod checks every 15 s and wakes you once, when all the runs of the push have ended, or earlier if one stalls (queued over 10 min, no step change over 20 min).
2. To check on the way, call `mcp__ci-watch__status`.
3. For a run the mod cannot find (another repository, a scheduled run), call `mcp__ci-watch__track { gh_run_id, repo: "owner/name" }` or `{ pr }`; `stall_minutes` overrides the limit.

## When a "[ci-watch] …" message arrives

It comes from the mod, not from the user. Act on it at once instead of waiting the same way again:

- **Local tests stalled**: read the end of the log (its path is in the message) and check the process (`ps`, `docker ps`, `docker compose logs --tail 50`). Common causes: a test waiting on the network or a port, a deadlock, an interactive prompt, no resources, buffered output (then it is not a stall: rerun unbuffered). Stop the task (TaskStop, `docker compose down -v`) and rerun it narrowed and with a timeout (`pytest --timeout=120`, `--maxfail`), or fix the cause.
- **Build or deploy stalled**: read the end of its log; a deploy that streams an image (`docker save | ssh … docker load`) can be quiet for a while, so check whether the transfer is still moving (the remote side, network) before stopping it. Never rerun a deploy blindly: find out what state the target is in first.
- **GitHub Actions or PR checks stalled**: a queued run means no runner or a concurrency group; a step that does not change is a hung job. Check `gh run view <id>` and `gh run view <id> --log-failed`. Cancel (`gh run cancel`) and rerun (`gh run rerun --failed`) only in repositories where you may.
- **GitHub runs or PR checks finished**: on failure, read `gh run view <id> --log-failed` for each failed run, fix and push. On success, carry on with the task.
- Then tell the user in a sentence or two what stalled and what you did about it.
