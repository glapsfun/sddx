# CLI reference

`sddx` is `bin/sddx-run dist/cli.mjs`, run from the plugin root: a bun-or-node
launcher executing a dependency-free bundle. Run it from the root of the
repository you're working in — all paths (`.sddx/`, worktrees) resolve against
the current directory.

```
usage:
  sddx task create --spec <path> [--workspace auto|worktree|branch|none] [--no-branch]
  sddx task phase <id> <PHASE> [--test-exit <n>]
  sddx task allow <id> <path>
  sddx task show <id>
  sddx red-check <id>
  sddx verify <id> [--model <m>] [--harness <h>]
  sddx board
  sddx audit [--signatures]
  sddx cleanup <id>
  sddx sweep
```

Exit codes across all commands: `0` success, `1` operation failed (spec
rejected, oracle failed, audit findings, refused cleanup), `2` usage error
(unknown command/flag, missing argument).

## sddx task create

```sh
sddx task create --spec <path> [--workspace auto|worktree|branch|none] [--no-branch]
```

Parses the spec ([spec-reference.md](spec-reference.md)) and registers the
task. A spec that fails validation prints one `spec error: …` line per problem
and exits 1 — a spec without an oracle never becomes a task.

`--workspace` (default `auto`):

- `auto` — worktree when possible; prints `submodules detected → branch mode`
  or `git worktree unavailable → branch mode` when downgrading.
- `worktree` — fresh worktree at `.sddx-worktrees/<id>` on branch `sddx/<id>`,
  forked from `origin/HEAD` (falls back to local HEAD with a notice when there
  is no origin). The spec is copied to `.sddx/specs/<id>.yaml` *inside the
  worktree*, and the task file lives in the worktree's own `.sddx/tasks/`.
- `branch` — creates and switches to `sddx/<id>` in the current checkout.
- `none` — run in place; no branch, no worktree. `--no-branch` is shorthand
  for `--workspace none`.

Output: `created <id> phase=PLAN …` with the worktree path, branch, and base
SHA as applicable. The id is `YYYYMMDD-<slug>`.

## sddx task phase

```sh
sddx task phase <id> <PHASE> [--test-exit <n>]
```

Requests a phase transition on `.sddx/tasks/<id>.json`. Transitions demand
evidence: `RED` requires `--test-exit` with a **non-zero** value (a passing
test is not RED), `GREEN` requires `--test-exit 0`. Invalid transitions exit 1
with the reason. Prints `<id> phase=<PHASE>`. Inside a Claude Code session the
recorder hook usually does this for you from observed test runs
([hooks.md](hooks.md)).

## sddx task allow

```sh
sddx task allow <id> <path>
```

Grants the sole, audited TDD-gate exemption: the exact path is appended to the
task's allow list, shown on the board, and copied into the receipt at
verification. Prints the full list: `<id> allow=[…]`.

## sddx task show

```sh
sddx task show <id>
```

Prints the task state file as JSON — phase, workspace, base SHA, allow list,
iteration count, timestamps.

## sddx red-check

```sh
sddx red-check <id>
```

Runs the task's oracle during RED and records its failure
(`evidence.oracle_red`). Exits 1 if the oracle passes — a pre-passing oracle
proves nothing and the spec must be fixed. `sddx verify` refuses tasks whose
`oracle_red` is missing or dated after the first GREEN.

## sddx verify

```sh
sddx verify <id> [--model <m>] [--harness <h>]
```

Executes the spec's oracle and settles the task. On success: writes the
hash-chained receipt, makes the atomic commit (code + spec + receipt), and
prints `verdict=pass receipt=<path> commit=<sha> duration_ms=<n>`. On failure:
prints `verdict=fail oracle_exit=<code> duration_ms=<n> iterations=<n>` and
exits 1 — **no receipt is written for a failed verification.**
`--model`/`--harness` are recorded in the receipt for provenance
([receipts-and-audit.md](receipts-and-audit.md)).

## sddx board

```sh
sddx board
```

Regenerates the deterministic `.sddx/BOARD.md` rollup and prints its path
(suffixed `(unchanged)` when the content didn't move). Never hand-edit the
board — regenerate it.

## sddx audit

```sh
sddx audit [--signatures]
```

Re-walks and re-hashes the receipt chain and checks commit bindings;
`--signatures` additionally verifies task-commit signatures. Prints one line
per finding to stderr and exits 1 on any finding — CI-friendly. Clean run:
`audit: <n> receipt(s) verified, chain intact`.

## sddx cleanup

```sh
sddx cleanup <id>
```

Tears down one task's workspace: removes `.sddx-worktrees/<id>` (refuses if it
has uncommitted changes) and deletes branch `sddx/<id>` (refuses if it is
checked out or not merged into HEAD). Each refusal prints
`refusing: …` and exits 1.

## sddx sweep

```sh
sddx sweep
```

Lock-guarded orphan sweep: removes leftover worktrees whose tasks are verified
DONE, skips everything else with a reason (`skipped <path> (<reason>)` — dirty
trees are never touched, they get flagged on the board). Prints
`sweep: <n> removed, <n> skipped`; a concurrent sweep prints
`sweep: another sweep holds the lock — skipped`.
