# sddx

## CLI at a glance

`sddx task create --spec <file> [--workspace auto|worktree|branch|none]` registers
a task; `auto` (default) runs it in an isolated worktree under `.sddx-worktrees/`
forked from `origin/HEAD`, downgrading to a `sddx/<id>` branch when submodules
make worktrees unsafe. `sddx sweep` removes leftover worktrees whose tasks are
verified DONE (lock-guarded; never touches dirty trees). `sddx cleanup <id>`
tears down a single task's worktree and merged branch. `sddx task allow <id>
<path>` grants the sole, audited TDD-gate exemption for one file — it is copied
into the task's receipt at verification.

## Hook-enforced TDD

The plugin registers five hooks (`hooks/hooks.json` → `dist/hooks.mjs`, one
dependency-free bundle launched via bun-or-node):

| Hook                    | Job                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `SessionStart`          | Bootstrap: orphan-worktree sweep, active tasks surfaced as session context               |
| `PreToolUse` (Edit/Write) | **TDD gate** — before GREEN (phases PLAN/RED), writes to implementation paths are denied |
| `PostToolUse` (Bash)    | Test-result recorder: observed test-runner exit codes drive PLAN→RED→GREEN               |
| `Stop` / `SubagentStop` | Refuses to conclude a session whose task lacks a verified receipt                        |

The gate classifies the target path in order: task `allow` list → exempt globs
(built-ins like `.sddx/**`, `docs/**`, `**/*.md`, plus userConfig
`exempt_globs`) → test globs (per-language defaults like `**/*.test.*`,
`tests/**`, `**/test_*.py`, plus userConfig `test_globs`) → otherwise
implementation, which is blocked pre-GREEN. Phase transitions are written by
hooks from observed exit codes — never claimed by the model. The gate resolves
its governing task from the written file's own workspace, so it behaves
identically in the main checkout, task worktrees, and subagents.

## Development

Prerequisites: [Bun](https://bun.sh) (version pinned in `.bun-version`) and
[pre-commit](https://pre-commit.com) (`brew install pre-commit`).

One-time setup after cloning:

```sh
bun install
pre-commit install --install-hooks
```

That installs both hook stages: fast hygiene + lint checks on `git commit`,
typecheck + tests on `git push`.

Everyday commands:

| Command            | What it does                               |
| ------------------ | ------------------------------------------ |
| `bun run lint`     | Biome lint + format check (TS/JS/JSON)     |
| `bun run lint:fix` | Auto-fix lint and formatting issues        |
| `bun test`         | Run the test suite                         |
| `bun run check`    | Full gate: lint → typecheck → test → build |

CI runs the same gates (`pre-commit run --all-files` plus typecheck, tests,
build, dist drift check, and strict plugin validation), so a clean local
`bun run check` and pre-commit pass means CI will agree.
