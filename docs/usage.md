# Usage

How work flows through sddx: the phase loop every task follows, the Claude
Code skills that drive it, the raw CLI underneath, and where your work ends up.

## The loop

```
PLAN ──► RED ──► GREEN ──► REFACTOR ──► VERIFY ──► DONE
```

- **PLAN** — the task exists with a spec and an oracle. The TDD gate blocks
  writes to implementation paths; only tests, docs, and exempt files go through.
- **RED** — a failing test has been *observed*: the recorder saw the test
  runner exit non-zero. Implementation paths are still blocked.
- **GREEN** — the same tests have been observed passing (exit 0). The gate
  opens; implementation writes are allowed.
- **REFACTOR** — optional cleanup; the tests must stay green.
- **VERIFY** — `sddx verify` executes the spec's oracle, diffs the outcome
  against the success criteria, writes a hash-chained receipt, and commits
  code + spec + receipt atomically.
- **DONE** — set only by the verifier, never by hand.

The rule underneath all of it: **phase transitions are written by hooks from
observed test exit codes — never claimed by the model.** See
[hooks.md](hooks.md) for the enforcement details.

## Inside Claude Code

**`/sddx:run`** — the flagship flow for a goal that decomposes into multiple
tasks. The orchestrator splits the goal into independent tasks with disjoint
file scopes; a planner writes each spec (no oracle, no goal); each task gets
its own worktree forked from `origin/HEAD`; tdd-executor agents run all tasks
in parallel; a verifier concludes each one with a receipt. You get a one-line
report per task, and merging the resulting `sddx/<id>` branches back is always
your decision — the agents never merge unasked.

**`/sddx:quick`** — one task through the same loop, on a `sddx/<id>` branch,
with evidence-gated phase transitions (`task phase <id> RED --test-exit <n>`
is rejected unless the observed exit code is actually non-zero).

**`--solo`** — for a trivial task: same hook gates, but run in the main
session with no subagents and no worktree. Mention it to `/sddx:run` and it
degrades to the `/sddx:quick` flow in-session.

## From the CLI

The same loop, by hand. `sddx` here means `bin/sddx-run dist/cli.mjs` from the
plugin root; every command is documented in [cli.md](cli.md).

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
sddx task create --spec spec.yaml --workspace none
```

`task create` registers the task and prints its id (`YYYYMMDD-<slug>`). On
disk: `.sddx/tasks/<id>.json` appears with `"phase": "PLAN"`.

1. **Write the failing test first.** The TDD gate blocks implementation paths
   until a failing run is observed.
2. **Run the tests** — `bun test tests/health.test.ts` fails; the recorder
   observes the non-zero exit and the task file moves to `"phase": "RED"`.
3. **Write the implementation, re-run the tests** — they pass; the task file
   moves to `"phase": "GREEN"`.

```sh
sddx task phase <task-id> VERIFY
sddx verify <task-id>
```

`verify` runs the oracle, writes `.sddx/receipts/<task-id>.json`, and makes
one atomic commit containing the code, the spec, and the receipt. Then:

```sh
sddx board   # regenerates .sddx/BOARD.md
sddx audit   # walks the receipt chain; exit 1 on any finding
```

## Workspaces and worktrees

`sddx task create --workspace <mode>` picks where the task runs:

- **`auto`** (default) — a fresh worktree under `.sddx-worktrees/`, forked
  from `origin/HEAD`, so parallel tasks never contaminate each other. When
  submodules (or nested worktrees) make that unsafe, it downgrades to branch
  mode with a one-line notice.
- **`worktree`** / **`branch`** — force one strategy. Branch mode works
  sequentially on a `sddx/<id>` branch in the main checkout.
- **`none`** — run in place; no branch, no worktree (the Quickstart above).

Cleanup:

- `sddx sweep` — removes leftover worktrees whose tasks are verified DONE.
  Lock-guarded and conservative: it never touches a worktree with uncommitted
  changes (those get flagged on the board instead).
- `sddx cleanup <id>` — tears down one task's worktree and its branch, and
  only if the branch is merged.

## The board

`sddx board` regenerates `.sddx/BOARD.md` — a deterministic rollup of every
task: phase, workspace, receipt status, and any flags (dirty worktrees, gate
exemptions). It is generated output: never hand-edit it, just re-run the
command. With `board_enabled` (default on) the SessionStart hook refreshes it
automatically.
