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
  sddx goal create --goal <sentence> --tasks <id1,id2,...>
  sddx goal show <id>
  sddx pr create --goal <goal-id> [--title <title>]
  sddx board
  sddx audit [--signatures] [--ci]
  sddx cleanup <id>
  sddx sweep
```

Exit codes across all commands: `0` success, `1` operation failed (spec
rejected, oracle failed, audit findings, refused cleanup), `2` usage error
(unknown command/flag, missing argument). Exit codes never depend on
`--output` — the same command run with a different output format always
exits the same way.

## Output formats

Every command accepts two global flags, in addition to its own:

- `--output <terminal|json|markdown|all>` (default `terminal`) — selects how
  the command's result is rendered. An unrecognized value exits 2 naming the
  accepted set.
- `--no-color` — disables ANSI color in terminal output (also honored via the
  `NO_COLOR` environment variable, and automatically when stdout isn't a TTY).

`terminal` (the default) is unchanged from earlier sddx releases: plain,
human-readable text, colorized only when attached to a TTY.

`json` emits exactly one JSON object to stdout, versioned independently of
the package version:

```json
{
  "schema_version": "1.0",
  "command": "board",
  "status": "success",
  "data": { "...": "command-specific payload" },
  "warnings": [],
  "errors": [],
  "metadata": { "plugin_version": "1.2.0", "harness": "claude-code", "messages": [] }
}
```

`schema_version`'s minor component increases for additive fields; its major
component increases only for a removed/renamed field or a type change — safe
to depend on for automation and AI agents parsing sddx output. `data` holds
the same information a human would read in terminal mode, just structured
per command (see each command's section below for its shape).

`markdown` emits a report — execution summary, task/receipt results (when
the command has any), warnings/errors, and a raw-data block — suitable for
pasting into a PR description or doc. `json` and `markdown` are always
built from the exact same result a given command run produced: selecting an
output format never changes what a command actually does, only how the
outcome is displayed.

`all` prints `terminal` to stdout as usual, and additionally writes
`sddx-<command>.json` and `sddx-<command>.md` to the current directory
(never overwriting an existing file — a numeric suffix is appended instead),
printing both paths as a final line.

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
([receipts-schema.md](receipts-schema.md)).

## sddx board

```sh
sddx board
```

Regenerates the deterministic `.sddx/BOARD.md` rollup and prints its path
(suffixed `(unchanged)` when the content didn't move). Never hand-edit the
board — regenerate it.

## sddx audit

```sh
sddx audit [--signatures] [--ci]
```

Re-walks and re-hashes the receipt chain and checks commit bindings;
`--signatures` additionally verifies task-commit signatures. `--ci` also
fails when a task marked `DONE` has no receipt (tamper-only CI gate — see
[receipts-schema.md](receipts-schema.md)). Prints one line per finding
to stderr and exits 1 on any finding — CI-friendly. Clean run:
`audit: <n> receipt(s) verified, chain intact`.

## sddx goal create

```sh
sddx goal create --goal <sentence> --tasks <id1,id2,...>
```

Persists `.sddx/goals/<goal-id>.json` listing the given task ids — the record
`sddx pr create --goal <goal-id>` later reads to know which tasks ship
together. Refuses if any listed task id doesn't exist, or if the derived goal
id already exists. `/sddx:run` calls this automatically after creating a
run's tasks; invoke it directly only when assembling a goal from tasks
created outside `/sddx:run`. Prints `created goal <id> tasks=[...]`.

## sddx goal show

```sh
sddx goal show <id>
```

Prints the goal state file as JSON — task ids, timestamps, and the `shipped`
marker once a PR has been opened for it.

## sddx pr create

```sh
sddx pr create --goal <goal-id> [--title <title>]
```

Opens **one PR per goal**: refuses unless every task in the goal is `DONE`
with a passing receipt (all-or-nothing, re-checked fresh at invocation time —
see [receipts-schema.md](receipts-schema.md)), then cherry-picks each
task's atomic commit onto a fresh `sddx/goal-<goal-id>` branch (task-creation
order), pushes it, and opens the PR via `gh` or `glab` — resolved from
`userConfig.pr_host` or detected from the `origin` remote. The PR body is
generated from the tasks' receipts, never hand-written. On success, writes a
`shipped` marker onto every task's branch and the goal file, which is what
lets `sddx cleanup` later remove a cherry-picked task branch despite it never
looking git-merged by ancestry.

Refuses loudly, before any git mutation, on: an incomplete goal (names the
blocking tasks and why), an unauthenticated or undetectable host CLI, or a
cherry-pick conflict (names the task whose commit failed; no partial branch
is left pushed). Prints `pr=<url> branch=<branch> tasks=[...]` on success.

This is a deliberately separate, explicitly-invoked command — `/sddx:run`
never calls it automatically, the same way it never merges branches
automatically. See [/sddx:pr](../../skills/pr/SKILL.md).

On GitLab this opens a **merge request** (`glab mr create`) — sddx calls the
command and output `pr` uniformly across both hosts since the mechanics
(one branch, cherry-picked commits, receipt-derived body) are identical;
only the underlying host object's name differs.

## sddx cleanup

```sh
sddx cleanup <id>
```

Tears down one task's workspace: removes `.sddx-worktrees/<id>` (refuses if it
has uncommitted changes) and deletes branch `sddx/<id>` (refuses if it is
checked out, or is neither merged into HEAD nor marked `shipped` by a prior
`sddx pr create`). Each refusal prints `refusing: …` and exits 1.

## sddx sweep

```sh
sddx sweep
```

Lock-guarded orphan sweep: removes leftover worktrees whose tasks are verified
DONE, skips everything else with a reason (`skipped <path> (<reason>)` — dirty
trees are never touched, they get flagged on the board). Prints
`sweep: <n> removed, <n> skipped`; a concurrent sweep prints
`sweep: another sweep holds the lock — skipped`.

## sddx next-actions

```sh
sddx next-actions [--select "<reply>"]
```

The deterministic "Next Actions" menu that replaces free-form completion
prose after a task's loop pauses or finishes. With no `--select`, detects the
current repository state (`uncommitted` / `committed-unpushed` /
`pushed-no-pr` / `pr-open` — from `git status`, upstream tracking, and a
PR/MR-existence check via `gh`/`glab`) and prints only the actions valid for
that state, numbered and grouped (Git / Development / Quality / Other). With
`--select "<reply>"`, re-detects state fresh, resolves `<reply>` against the
menu (either the printed number or a case-insensitive match on the action's
label — e.g. `"1"` and `"commit"` both select **Commit**), and executes it,
printing the observable result (new commit SHA, PR/MR URL, diff, etc). A
`<reply>` that no longer matches a currently-valid action (state drifted
since the menu was shown) or matches more than one action is refused with
the menu re-printed, exit 1 — nothing executes.

If the PR/MR-existence check can't reach the host (no `gh`/`glab`
authentication, or the remote isn't GitHub/GitLab), the state degrades to
`pushed-no-pr` with a one-line `warning:` rather than failing — PR-dependent
actions are simply omitted from that menu.

The action set is a static, data-driven catalog (`src/lib/next-actions.ts`):
each entry declares the states it's valid in. Adding a new action is a new
catalog entry — it never requires changing state detection or the selection
parser. A handful of future actions (release, tag, deploy, changelog,
security/perf scans, dashboard, branch switch) are already listed in the
catalog with `implemented: false`, so they never appear in a menu yet, but
the shape is there.

Used by `/sddx:quick` and `/sddx:verify` as the default post-task hand-off,
in place of the model composing its own "what's next" prose.

## sddx config show

```sh
sddx config show [--output <terminal|json|markdown|all>]
```

Prints every `userConfig` key fully resolved (environment variable, then
`.sddx/config.json`, then built-in default — see
[../how-to/install-sddx.md](../how-to/install-sddx.md) for the full key table). Read-only: never
writes `.sddx/config.json` or any other file. `agent_model` is printed as
parsed `role=model` pairs (malformed segments are silently dropped here —
run `sddx config validate` to see why). `pr_host` prints
`(auto-detected from origin remote)` when unset, since resolving it for real
means inspecting the git remote (see [sddx pr create](#sddx-pr-create)) — this
command doesn't shell out to git just to show config.

`/sddx:run` and `/sddx:quick` call `config show --output json` once at the
start of their flow and use `.data.agent_model` / `.data.prefer_solo` from the
result — advisory only, since no hook enforces a skill's own instructions.

When `verbose` is true, an extra `resolution detail` block follows the
resolved values in `terminal` mode, naming which source — `env`, `config`, or
`default` — won for each key. This is the one place `verbose` currently has
an effect on `terminal` output; it does not change any other command's
output.

`--json` (bare, not `--output json`) still works as a **deprecated alias**
for `--output json`: it emits the same versioned JSON envelope described in
[Output formats](#output-formats) (the resolved config lives under `data`,
not at the top level as in sddx releases before this one) and prints a
one-line deprecation notice to stderr. Prefer `--output json` going forward.

## sddx config validate

```sh
sddx config validate
```

Checks `.sddx/config.json` against the known schema and reports, as warnings
(exit 0): unrecognized top-level keys, values that fail their key's domain
rule (not just a `typeof` mismatch — `stuck_threshold`/`oracle_runs_default`/
`max_iterations_default` must be positive integers, `workspace_mode` must be
one of `auto|worktree|branch|none`, `pr_host` one of `gh|glab`), and malformed
`agent_model` segments. Missing `.sddx/config.json` is not an
error — it just means built-in defaults apply. Unparseable JSON (or JSON
that isn't an object) is the one case that fails loudly (exit 1): that's a
broken file, not a schema mismatch.
