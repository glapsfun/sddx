# sddx

Loop-based Spec-Driven Development for Claude Code: dense specs with mandatory
oracles, hook-enforced TDD, parallel git worktrees, and hash-chained receipts.
Process over intelligence, proof over promises.

## Install

**Marketplace (recommended):**

```sh
claude plugin marketplace add glapsfun/sddx
claude plugin install sddx@sddx
```

**Local development** — run Claude Code with the plugin loaded from a checkout:

```sh
claude --plugin-dir /path/to/sddx
```

**Skills only** — copy the `skills/` subdirectories into your project's
`.claude/skills/`; skills auto-load, but hook enforcement (the TDD gate) only
ships with the full plugin.

## Quickstart (first verified task in ~5 minutes)

```sh
mkdir demo && cd demo && git init
cat > spec.yaml <<'EOF'
task: health endpoint returns ok
context: []
success_criteria:
  - "bun test tests/health.test.ts exits 0"
oracle:
  type: command
  run: "bun test tests/health.test.ts"
  expect: exit 0
stop_rules:
  - max_iterations: 5
out_of_scope: []
EOF
sddx task create --spec spec.yaml --workspace none   # registers the task (phase PLAN)
# 1. write the failing test first — the TDD gate blocks implementation paths
#    until a failing run is observed
# 2. run: bun test tests/health.test.ts   → recorder moves the task to RED
# 3. write the implementation, re-run the tests → GREEN
sddx task phase <task-id> VERIFY
sddx verify <task-id>        # runs the oracle, writes the receipt, commits atomically
sddx board                   # renders .sddx/BOARD.md
sddx audit                   # verifies the receipt hash chain
```

Inside Claude Code the same loop is driven by `/sddx:quick` (single task) or
`/sddx:run` (parallel tasks in worktrees); `sddx` here means
`bin/sddx-run dist/cli.mjs` from the plugin root.

## CLI at a glance

`sddx task create --spec <file> [--workspace auto|worktree|branch|none]` registers
a task; `auto` (default) runs it in an isolated worktree under `.sddx-worktrees/`
forked from `origin/HEAD`, downgrading to a `sddx/<id>` branch when submodules
make worktrees unsafe. `sddx sweep` removes leftover worktrees whose tasks are
verified DONE (lock-guarded; never touches dirty trees). `sddx cleanup <id>`
tears down a single task's worktree and merged branch. `sddx task allow <id>
<path>` grants the sole, audited TDD-gate exemption for one file — it is copied
into the task's receipt at verification. `sddx board` regenerates the
deterministic `.sddx/BOARD.md`; `sddx audit [--signatures]` verifies the receipt
chain, commit bindings, and optionally commit signatures (exit 1 on any finding
— CI-friendly).

## Spec reference

Task specs are one YAML file; every field below is required.

| Field              | Meaning                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `task`             | One sentence stating the goal; also the source of the task id (`YYYYMMDD-<slug>`)                             |
| `context`          | List of pointers (files, CONTEXT.md sections) — links, not prose                                              |
| `success_criteria` | List of binary, observable statements; no "improve"/"better"                                                  |
| `oracle`           | The mandatory proof: `type` (`command` \| `test-suite` \| `browser` \| `manual`), `run` (shell command), `expect` (`exit <code>`) |
| `stop_rules`       | Loop bounds, e.g. `max_iterations: 5`, escalation conditions                                                  |
| `out_of_scope`     | Explicit exclusions so the loop doesn't wander                                                                |

A spec without an oracle is rejected at registration — no oracle, no goal.

## Hook-enforced TDD

The plugin registers five hooks (`hooks/hooks.json` → `dist/hooks.mjs`, one
dependency-free bundle launched via bun-or-node):

| Hook                    | Job                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `SessionStart`          | Bootstrap: orphan-worktree sweep, board refresh, active tasks surfaced as session context |
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

## Privacy

sddx makes **zero network calls**. Everything is local files (`.sddx/` under
version control) and local git. No telemetry, no phoning home, no remote
fetches — the bundles ship dependency-free and never import a network API.

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

Releases follow the checklist in [docs/RELEASING.md](docs/RELEASING.md).
