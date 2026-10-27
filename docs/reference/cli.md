# CLI reference

`sddx` runs a dependency-free bundle under Bun. Run it from anywhere inside the
repository you are working in: paths resolve against the main repository root,
including when you call it from inside a task's worktree.

```
usage:
  sddx spec check <spec.md>
  sddx plan check <spec.md>
  sddx plan approve <spec.md> [--harness <name>]
  sddx plan start <spec.md>
  sddx task ready --goal <goal-id>
  sddx task start <id>
  sddx task abandon <id> --reason <text>
  sddx task show <id>
  sddx verify <id>
  sddx review record <id> --verdict <pass|fail> [--findings <file>] [--reviewer <name>]
                     [--harness <name>] [--model <name>]
  sddx goal show <goal-id>
  sddx run report --goal <goal-id>
  sddx pr create --goal <goal-id> [--title <title>]
  sddx next-actions --goal <goal-id> [--select <reply>]
  sddx board
  sddx audit [--signatures] [--ci]
  sddx cleanup <id>
  sddx sweep
  sddx config show
  sddx config validate
  sddx doctor
  sddx migrate [--yes]
strict profile only:
  sddx task phase <id> <RED|GREEN> --test-exit <n>
  sddx task allow <id> <path>
```

Exit codes, for every command: `0` success, `1` the operation failed or was
refused, `2` usage error (unknown command or flag, missing argument, a command
that does not exist in the current profile), `3` approval required (`plan
start` in `human` mode with no approval token for the plan; nothing was
written). Exit codes never depend on `--output`.

A repository still holding sddx 5 state (a `schema_version` 1.x config, or a
v5 task file) is refused by every command except `migrate`, `audit` and
`doctor`, with a pointer to [sddx migrate](#sddx-migrate).

## The lifecycle at a glance

```
 spec check -> plan check -> plan approve -> plan start
                                               |
                         task ready / task start <id>       (PLANNED -> IN_PROGRESS)
                                               |
                                verify <id>                 (IN_PROGRESS -> IN_REVIEW)
                                               |
                  review record <id> --verdict pass         (IN_REVIEW -> DONE: receipt, commit, merge)
                  review record <id> --verdict fail         (IN_REVIEW -> IN_PROGRESS)
```

`task abandon` moves any unfinished task to `ABANDONED`, or back to `PLANNED`
when its retry policy has attempts left. `DONE` and `ABANDONED` are terminal.
There is no command that sets an arbitrary state.

## Output formats

Every command accepts two global flags:

- `--output <terminal|json|markdown|all>` (default `terminal`). An
  unrecognized value exits 2.
- `--no-color` disables ANSI color (also honored via `NO_COLOR`, and automatic
  when stdout is not a TTY).

`json` emits exactly one versioned envelope on stdout:

```json
{
  "schema_version": "1.0",
  "command": "board",
  "status": "success",
  "data": { "...": "command-specific payload" },
  "warnings": [],
  "errors": [],
  "metadata": { "plugin_version": "6.0.0", "harness": "unknown", "messages": [] }
}
```

The minor part of `schema_version` grows for additive fields; the major part
only for a removed or renamed field. `markdown` renders the same result as a
report. `all` prints terminal output and also writes `sddx-<command>.json` and
`sddx-<command>.md`. The format never changes what a command does.

## sddx spec check

```sh
sddx spec check .sddx/specs/2026-10-26-rate-limit.md
```

Validates a goal spec and writes nothing. Exits 0 with status `ready`, or
status `draft` while `### Open decisions` has items (those are listed as
warnings). Exits 1 listing every error as `path:line: message`; with
`--output json` the same errors are under `data.errors` as
`{message, path, line}`. The format is in [spec-reference.md](spec-reference.md).

## sddx plan check

```sh
sddx plan check <spec.md>
```

Everything `plan approve` and `plan start` would check, and nothing written:
the spec itself, at least one task, known and acyclic dependencies, disjoint
scopes for tasks that can run at the same time, an empty Open decisions list,
task ids not used by any existing task, branch, worktree or receipt, no
existing goal or run branch for this spec, and worktree preconditions (git can
create worktrees; no task's scope reaches a submodule). On success it prints
the plan hash, goal id, base commit, run branch, each task with its scope and
oracle, the interaction mode and whether the plan is already approved.

The plan hash is the sha256 of the spec file's bytes. Any edit, prose included,
is a different plan.

## sddx plan approve

```sh
sddx plan approve <spec.md> [--harness <name>]
```

Runs `plan check` first and refuses an invalid plan. Writes the approval token
`.sddx/approvals/<plan-hash>.json`, recording `mode: human`, the time, and the
reported harness when `--harness` is given. When git is configured for SSH
signing (`gpg.format ssh`, `user.signingkey`), the token is signed under the
`sddx-approval` namespace; a signed token is what makes human approval provable
in `sddx audit`. In `auto` mode a plan that breaks an autonomy bound is refused
here too, so approving never produces a token the start would reject.

## sddx plan start

```sh
sddx plan start <spec.md>
```

In `human` mode, refuses with exit 3 unless an approval token exists for the
spec's current hash. In `auto` mode, refuses with exit 1 when any autonomy
bound is exceeded (a manual oracle, a task with no scope, a scope reaching
sddx's own enforcement paths or a protected area, a non-empty Open decisions
list, more tasks than `auto_max_tasks`), with a structured blocker under
`data.blocker`. The mode comes from `.sddx/config.json` only. See
[interaction-modes.md](../explanation/interaction-modes.md).

On success, all or nothing:

- the run branch `sddx/run-<goal-id>` at the base commit, plus one commit on it
  holding the exact spec bytes that were approved;
- one `PLANNED` task file per task in `.sddx/tasks/` of the main checkout;
- the goal record in the git ref `refs/sddx/goals/<goal-id>`;
- `.sddx/config.json` with defaults, when the repository has none.

No worktree is created here. Running `plan start` again for the same spec
exits 1 naming the existing goal.

## sddx task ready

```sh
sddx task ready --goal <goal-id>
```

Lists the goal's `PLANNED` tasks whose dependencies are all `DONE`, one per
line (`data.ready` in JSON), so an orchestrator can start them at the same
time. Lists nothing while the goal is halted by a `block` policy.

## sddx task start

```sh
sddx task start <id>
```

Requires `PLANNED` and every dependency `DONE`. Creates the worktree
`.sddx-worktrees/<id>` on branch `sddx/<id>`: a root task forks from the run
branch head, a dependent from its first parent's `DONE` commit with the other
parents merged in. A worktree kept by a `reuse` retry is reused. Moves the task
file into the worktree, records the effective profile on the task, sets
`IN_PROGRESS`, and prints the absolute worktree path. Refuses, naming the
reason, when a dependency is not `DONE` or the goal is halted.

## sddx task abandon

```sh
sddx task abandon <id> --reason "<why>"
```

Records the reason. When a started task's `retry.max_attempts` allows another
attempt, the task returns to `PLANNED` with its attempt count increased: a
`fresh` retry removes the worktree and branch, a `reuse` retry keeps them. A
task that never started has no attempt to retry, so it is abandoned directly.
Otherwise the task becomes `ABANDONED`, and every `PLANNED` descendant with
`on_dependency_failure: skip` (the default) becomes `ABANDONED` with reason
`skipped` and `skipped_on` naming the abandoned dependency. A descendant with
`block` halts the whole goal: no further task in it can start.

An abandoned task's state moves to the main checkout's `.sddx/tasks/`, so the
record survives when its worktree is cleaned up. The worktree keeps any
uncommitted work, and is removed only once it is clean.

## sddx task show

```sh
sddx task show <id>
```

Prints the task's state file as JSON, wherever it currently lives (its
worktree, the main checkout, or its branch tip after the worktree was swept).

## sddx verify

```sh
sddx verify <id>
```

Requires `IN_PROGRESS`, a non-manual oracle, the same profile the task was
started under, and a task file whose `oracle` and `scope` match the approved
spec. It records the worktree's content as a git tree (without touching the
worktree's files or index), refuses any change under `.sddx/` and
implementation changes outside the task's `scope`, then runs the boundary proof
in a throwaway proof worktree:
the oracle must **fail** on the base commit plus only the changed test files,
and **pass** `runs` times on the verified tree. See
[verification.md](verification.md).

A pass moves the task to `IN_REVIEW`, prints the verified tree, and writes the
proof record that `review record` trusts to `.git/sddx-proofs/<id>.json`;
nothing is committed and no receipt is written yet. A failure leaves the task
`IN_PROGRESS`, records which half failed with its exit code, and exits 1. The
same failure `stuck_threshold` times in a row marks the task stuck; reaching
`max_iterations_default` (verify runs plus failed reviews) asks for a person.

## sddx review record

```sh
sddx review record <id> --verdict pass --reviewer critic
sddx review record <id> --verdict fail --findings review.md
```

Requires `IN_REVIEW`, and the proof record `verify` wrote for the task's
current attempt (the task file's own `verified` block is never trusted). A
`fail` verdict needs `--findings` (exit 2 otherwise).

First the worktree's content is compared with the tree `verify` proved. If
anything changed, the review is refused, the task returns to `IN_PROGRESS`, and
the command exits 1: a review must cover exactly what gets merged. Otherwise the
review entry stores the sha256 of the verified diff, the findings file's hash,
and the reviewer as reported.

- `fail`: the task returns to `IN_PROGRESS`; the review counts toward the
  iteration limit.
- `pass`: the task is finalized. One commit on the task's branch holds the
  verified tree plus exactly two files, the task state and a version 5 receipt
  (see [receipts-schema.md](receipts-schema.md)); that commit is merged into the
  run branch with `git merge --no-ff`, and the task is `DONE`. A merge conflict
  is aborted, leaves the run branch unchanged, is recorded in the goal's merge
  log, and is reported with the conflicting paths.

The finalize commit is built from the proven tree with git plumbing, never by
staging the worktree, so a later edit, a stray file under `.sddx/`, or a
`pre-commit` hook cannot put unproven content in it. Hooks do not run on sddx's
commits or merges: run formatters and linters before `verify`, or make them
part of the oracle. Commit signing still applies when `commit.gpgSign` is set.

Nothing is written until that commit exists. If it cannot be made (a failing
signer, say), or the run branch is checked out in another worktree, the command
exits 1 and the task stays `IN_REVIEW` with no receipt; fix the cause and record
the review again. If the merge itself then fails for another reason, the task is
`DONE` and committed on `sddx/<id>`, the run branch is unchanged, and the output
says how to merge it by hand.

`--harness` and `--model` are recorded on the receipt as reported values. sddx
cannot judge a review's quality; `audit` describes a review as recorded, never
as verified.

## sddx goal show

```sh
sddx goal show <goal-id>
```

Prints the goal record (title, spec path, task ids, dependency edges, run
branch, base commit, approval provenance, merge log) from
`refs/sddx/goals/<goal-id>`. The ref is pushed by `pr create`; fetch it with
`git fetch origin 'refs/sddx/goals/*:refs/sddx/goals/*'`.

## sddx run report

```sh
sddx run report --goal <goal-id>
```

The run summary: run branch, target branch (stated unchanged), counts of
merged, failed, skipped, blocked, conflicted and outstanding tasks, each task
with its state, attempt, abandon reason and receipt location, oracle results,
a `git diff --stat` against the base, and the commands to review the result.

## sddx pr create

```sh
sddx pr create --goal <goal-id> [--title <title>]
```

Pushes the run branch as it stands and opens a PR (`gh`) or MR (`glab`),
resolved from `pr_host` or the `origin` remote. The body is built from the
goal's merge log and the receipts of the tasks merged so far, and states how
many are outstanding. The goal ref is pushed alongside. A goal already shipped
is refused instead of opening a duplicate. Merging into your target branch is
always your decision; nothing in sddx does it.

## sddx next-actions

```sh
sddx next-actions --goal <goal-id> [--select "<reply>"]
```

The goal-scoped hand-off menu: review changes, create a PR, merge into the
target branch, retry an abandoned task, revert a merged task. Built from current
run state each time; a selection is re-validated before it runs.

## sddx board

```sh
sddx board
```

Regenerates `.sddx/BOARD.md`: one row per task with its goal, state (plus
` stuck` and ` blocked-on-<id>` flags), dependencies, title, attempt,
iterations, receipt sequence number, and a note (abandon reason or strict
allow list), followed by any worktrees the sweep refused to remove.

## sddx audit

```sh
sddx audit [--signatures] [--ci]
```

Validates every receipt of versions 1 to 5 against its own schema, checks the
`prev` hash links, binds each receipt to the commit that introduced it, checks
approval provenance against the goal record, and verifies approval and receipt
signatures. Exits 1 on any finding. For version 5 receipts it states what is and
is not provable: human approval is provable only for a signed approval whose
signature verifies; a reported harness is labelled as reported; a review is "a
recorded review, not a verified one". `--signatures` also verifies the binding
commits' git signatures. `--ci` adds the tamper-only checks a pull request gate
needs (a `DONE` task without a receipt).

## sddx cleanup

```sh
sddx cleanup <id>
```

Removes `.sddx-worktrees/<id>` and deletes branch `sddx/<id>` once it is merged
into HEAD or into its goal's run branch, as the goal's merge log records. It
refuses a task that is not `DONE` or `ABANDONED`, whose worktree holds its only
state, and a worktree with anything uncommitted, `.sddx/` included. An
abandoned task's branch is deleted only when it holds no commit beyond its
base.

## sddx sweep

```sh
sddx sweep
```

Removes worktrees of `DONE` (with a receipt) or `ABANDONED` tasks that are
clean (nothing uncommitted, `.sddx/` included), and any proof worktree whose
`verify` is no longer running. Everything else, a proof a running `verify`
still owns included, is skipped with a reason and flagged on the board. Runs
automatically at session start through the session hook.

## sddx config show

```sh
sddx config show
```

Prints every config key fully resolved (environment variable where the key has
one, then `.sddx/config.json`, then the default). With `verbose: true`, also
names which source won for each key. See [config.md](config.md).

## sddx config validate

```sh
sddx config validate
```

Checks `.sddx/config.json` against the schema and exits 1 on any issue:
an unrecognized or removed key, a value outside its key's domain (for example
`"profile": "strikt"`), a malformed `agent_model`, or a `schema_version` from
sddx 5. A missing file is fine: defaults apply.

## sddx doctor

```sh
sddx doctor
```

Read-only diagnosis, each problem with the exact command that fixes it: Bun,
the git repository, the sddx version, the config, and leftover sddx 5
integration files.

## sddx migrate

```sh
sddx migrate         # preview
sddx migrate --yes   # apply
```

Moves a repository from sddx 5 to 6. See
[migrate-to-v6.md](../how-to/migrate-to-v6.md).

## sddx task phase (strict profile)

```sh
sddx task phase <id> RED --test-exit <nonzero>
sddx task phase <id> GREEN --test-exit 0
```

Records a test run the hook recorder could not observe (an unrecognized test
runner). The exit code is checked: RED needs a failing run, GREEN a passing
one. Exits 2 outside the strict profile. See [hooks.md](hooks.md).

## sddx task allow (strict profile)

```sh
sddx task allow <id> <path>
```

Exempts one exact repository-relative path from the strict gate for this task.
Every exemption is listed on the receipt and the board. Refused in `auto` mode,
and exits 2 outside the strict profile.
