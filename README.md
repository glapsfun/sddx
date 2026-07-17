# sddx

## CLI at a glance

`sddx task create --spec <file> [--workspace auto|worktree|branch|none]` registers
a task; `auto` (default) runs it in an isolated worktree under `.sddx-worktrees/`
forked from `origin/HEAD`, downgrading to a `sddx/<id>` branch when submodules
make worktrees unsafe. `sddx sweep` removes leftover worktrees whose tasks are
verified DONE (lock-guarded; never touches dirty trees). `sddx cleanup <id>`
tears down a single task's worktree and merged branch.

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
