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
  sddx graph create --graph <path> [--workspace auto|worktree|branch|none] [--dry-run]
  sddx graph approve --graph <path> [--workspace auto|worktree|branch|none]
  sddx pr create --goal <goal-id> [--title <title>]
  sddx run report --goal <goal-id>
  sddx board
  sddx audit [--signatures] [--ci]
  sddx cleanup <id>
  sddx sweep
```

Exit codes across all commands: `0` success, `1` operation failed (spec
rejected, oracle failed, audit findings, refused cleanup), `2` usage error
(unknown command/flag, missing argument), `3` **approval required** (`graph
create` in `human` mode with no valid approval token — nothing was written).
Exit codes never depend on `--output` — the same command run with a different
output format always exits the same way.

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
  or `git worktree unavailable → branch mode` when downgrading. **`graph create`
  does not downgrade**: there `auto` means worktree, and a failed worktree
  precondition refuses the run rather than silently moving it into a weaker
  isolation model. The downgrade survives only on this legacy `task create`
  path, which `retire-alternate-flows` removes.
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

**Refused in `auto` mode.** The allow list is the only escape hatch from the TDD
gate, so an unattended run that could widen it would have no gate. This is an
absolute invariant, not a threshold: granting an exemption requires a human in
both modes. Set `execution_mode: "human"` in `.sddx/config.json` to grant it
(there is no `--mode` flag, and no environment override — see
[config.md](config.md#the-two-gate-keys-are-config-only-on-purpose)).

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
prints `verdict=pass receipt=<path> commit=<sha> duration_ms=<n>`. If the task
belongs to a goal, this same command then merges its commit into that goal's
run branch automatically (`git merge --no-ff`, never a cherry-pick, no
confirmation asked) and prints a second line: `integrated: merged into
<run-branch> (<merge-sha>)`, or, on conflict, a loud error naming the task as
verified-but-not-integrated — the task's own `DONE` phase and receipt are
unaffected either way. On failure: prints `verdict=fail oracle_exit=<code>
duration_ms=<n> iterations=<n>` and exits 1 — **no receipt is written for a
failed verification.** `--model`/`--harness` are recorded in the receipt for
provenance ([receipts-schema.md](receipts-schema.md)).

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

Persists the goal record listing the given task ids, and creates
its run branch (`sddx/run-<goal-id>`, forked from the resolved `origin/HEAD`)
— the record `sddx pr create --goal <goal-id>` later reads to know what to
push. Refuses if any listed task id doesn't exist, or if the derived goal id
already exists. `/sddx:run` calls this automatically (via `graph create`,
which creates the run branch *before* any task starts); invoke it directly
only when assembling a goal from tasks created outside `/sddx:run` — in that
case the run branch starts empty, since tasks already `DONE` before the goal
existed don't retroactively appear merged. Prints
`created goal <id> tasks=[...] run_branch=<branch>`. The goal file itself is
plain, never-committed local state (like `.sddx/sweep.json`), so it stays
visible across branch switches regardless of workspace mode.

## sddx goal show

```sh
sddx goal show <id>
```

Prints the goal state file as JSON — task ids, run branch, base SHA, the
`merges` log (one entry per integration attempt: `merged`, `conflict`, or
`reverted`), and the `shipped` marker once a PR has been opened for it.

## sddx graph create

```sh
sddx graph create --graph <path> [--workspace auto|worktree|branch|none] [--dry-run]
```

The atomic gate between a draft plan and a materialized one. Validates every
node's oracle, the DAG (cycle-free, `overlap ⟹ ordered` including fan-in
co-parents), and every `on_dependency_failure`/`retry` value; then creates the
goal's run branch, every task file, and `.sddx/goals/<goal-id>.json` — or writes
**nothing** and names the offending node.

`--dry-run` runs the identical resolve-and-validate path and writes nothing,
printing the goal, node list with each oracle and scope, dependency edges,
topological execution order, the **effective workspace mode** (downgrades
applied), the **resolved base SHA**, and the validation verdict. This is the
approval screen: those last three are decided inside `graph create` and are
absent from the drafts. A second `--dry-run` of a revised plan prints only what
changed.

In `human` mode (the default), creation requires a matching approval token and
exits **3** without one, having written nothing. Validation runs first, so an
invalid plan exits 1 and is never presented for approval. `auto` self-approves
within its bounds; see
[execution-modes.md](../explanation/execution-modes.md#auto-modes-bounds).

## sddx graph approve

```sh
sddx graph approve --graph <path> [--workspace auto|worktree|branch|none]
```

Records approval of the plan **as it currently stands on disk**, writing
`.sddx/approvals/<plan_sha256>.json`. Refuses a plan that fails validation, so
approval can never be granted to something that cannot execute. Prints the
approved hash and the token path.

`plan_sha256` covers the graph file's bytes plus every referenced spec's bytes,
so any subsequent edit — including a semantically-neutral reorder — invalidates
the token and re-arms the gate. Tokens are content-addressed, so a plan
regenerated byte-identically reuses its approval.

A token records the **workspace strategy** it was approved under, so pass the
same `--workspace` you intend to create with. Approving a `worktree` render does
not authorize `--workspace none`, which would move every task into your live
checkout instead of an isolated worktree; `graph create` exits 3 on the mismatch
rather than silently dropping the isolation you approved.

A token always records `mode: human` — approving *is* the deliberate act, so a
receipt reading `mode: auto` always means no human saw that plan. When
`execution_mode` is `auto` and a blast-radius bound armed the gate anyway, the
token additionally records `requested_mode: auto` and the bound that tripped, so
the degradation is visible without weakening what `mode` means.

Signed best-effort under the `sddx-approval` SSH namespace when git signing is
configured; an unsigned token is normal, never an error. A signature only binds
approval to a person when the key is touch-required — see
[what sddx can and cannot prove](../explanation/execution-modes.md#what-sddx-can-and-cannot-prove).

## sddx run report

```sh
sddx run report --goal <goal-id>
```

The run-completion report: run branch, target branch (stated unchanged),
merged/failed/outstanding task counts, a `git diff --stat` summary against
the run branch, and the exact review commands (`git switch`, `git diff`,
`git log --oneline`). Meaningful at any point in a run, not just the end —
the header reads "Run in progress" while anything is still outstanding,
"Run completed" once nothing is.

## sddx pr create

```sh
sddx pr create --goal <goal-id> [--title <title>]
```

Pushes the goal's run branch **exactly as it stands** — whatever subset of
tasks has merged into it so far, no completeness gate — and opens a PR/MR
from it via `gh` or `glab` (resolved from `userConfig.pr_host` or detected
from the `origin` remote). No branch reconstruction happens here: every
commit on the run branch is either a task's own atomic commit or a real
`git merge --no-ff` that `sddx verify` already made as each task passed (see
`sddx verify` below). The PR body is generated from the goal's `merges`
log — only tasks currently merged, each with its receipt's oracle command,
exit code, and hash — and states the outstanding count rather than implying
full completion. On success, writes `shipped: {pr_url, at}` onto the goal
file; re-running `pr create` for an already-shipped goal refuses rather than
opening a duplicate.

Refuses loudly, before any push, on: an already-shipped goal, or an
unauthenticated or undetectable host CLI. Prints
`pr=<url> branch=<branch> tasks=[...]` on success (`taskIds` here is the
currently-merged subset, not the full goal).

This is a deliberately separate, explicitly-invoked command — `/sddx:run`
never calls it automatically, the same way it never merges into the
*original target branch* automatically. See [/sddx:pr](../../skills/pr/SKILL.md).

On GitLab this opens a **merge request** (`glab mr create`) — sddx calls the
command and output `pr` uniformly across both hosts since the mechanics (one
branch, receipt-derived body) are identical; only the underlying host
object's name differs.

## sddx cleanup

```sh
sddx cleanup <id>
```

Tears down one task's workspace: removes `.sddx-worktrees/<id>` (refuses if it
has uncommitted changes) and deletes branch `sddx/<id>` (refuses if it is
checked out). If the branch isn't merged into HEAD by ancestry, it's still
accepted when the goal it belongs to (if any) currently lists it as `merged`
in that goal's `merges` log — real bookkeeping sddx itself wrote, not a
self-reported marker, and revert-aware (a reverted merge doesn't count). Each
refusal prints `refusing: …` and exits 1.

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
sddx next-actions --goal <goal-id> [--select "<reply>"]
```

The deterministic, **goal-scoped** hand-off shown once after a run summary.
`--goal` is required.

The current-branch variant (`sddx next-actions` with no `--goal`, filtering a
static catalog by a detected `uncommitted` / `committed-unpushed` /
`pushed-no-pr` / `pr-open` state) has been removed. It answered a question
about the checkout rather than about the run, and it could offer per-task
hand-offs before the run reached its single hand-off point — including for a
branch that had nothing to do with the run.

**Selection is authorization.** The menu is recomputed from current run state
at display time, and displaying it authorizes nothing. When the user selects an
offered action, that selection *is* the authorization: a selected remote or
target-branch action is performed without asking again. A second confirmation
would train the user to click through the one prompt that carries meaning. The
exception is an action destructive of existing work, which still confirms.

Before executing, run state is re-derived and the selection re-validated: a
reply that no longer matches a currently-valid action (state drifted since the
menu was shown) or matches more than one is refused with the menu re-printed,
exit 1 — nothing executes.

### What the menu offers

Built dynamically from the goal's `merges` log rather than a fixed catalog: Review
Changes and Exit always appear; Create PR/MR and Merge Into Target Branch
appear once at least one task has merged; one Retry `<task-id>` entry appears
per `ABANDONED` task; one Revert `<task-id>` entry appears per currently-
merged task (executing it runs `git revert -m 1` on the run branch and
records a `reverted` entry in the goal's `merges` log — no history rewriting,
no force-push). Selection (numeric or natural-language, e.g. `"revert
<task-id>"`) works exactly like the per-task menu.

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
