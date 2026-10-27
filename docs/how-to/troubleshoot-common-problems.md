# Troubleshooting

The most common surprises, what they mean, and the fix. Most are a gate doing
its job: sddx refuses rather than guesses, and every refusal says why and what
to do.

## Session start says sddx needs Bun

**Cause:** the plugin's hooks and CLI run on Bun, and none was found on `PATH`
or in `~/.bun/bin`.

**Fix:** install it, then start a new session:

```sh
curl -fsSL https://bun.sh/install | bash
```

Until then the hooks pass everything through, except that the approval gate
asks you about any command that mentions sddx.

## "Another sddx comes first on PATH"

**Cause:** an older `sddx`, usually a global npm install of sddx 5, is on your
`PATH`. Claude Code puts the plugin's own `bin/` after your `PATH` entries, so
in the agent's shell that older one would win. Session start detects this and
tells the agent to run the plugin's CLI by its absolute path instead.

**Fix:** nothing is broken, but remove the older install so plain `sddx` works
again:

```sh
npm uninstall -g @glapsfun/sddx
```

or `bun remove -g @glapsfun/sddx` if Bun installed it.

## The agent doesn't use sddx

**Cause:** one of:

- the repository has no `.sddx/`, so session start only says that sddx is
  available. Start a goal with `/sddx:brainstorm`; from then on every session in
  the repository gets the router;
- the plugin is not installed or not enabled here: check the `/plugin` menu.
  A teammate's `.claude/settings.json` can enable it for the repository, but
  each person still installs it ([Share sddx with a team](share-sddx-with-a-team.md));
- the repository was set up by sddx 5: session start points to `sddx migrate`
  instead of loading the router ([Migrate to sddx 6](migrate-to-v6.md));
- you are on Windows, where the plugin's hooks do not run yet.

## `sddx plan approve` is refused

**Cause:** approval is the human act, so the plugin's approval gate always
raises your permission dialog for it. If you declined the dialog, nothing was
approved. Under `claude -p` there is no dialog, so Claude Code refuses the
command and tells the agent why.

**Fix:** review the plan with `sddx plan check <spec>`, then approve it in an
interactive session, or run the command yourself from a terminal:

```sh
bunx @glapsfun/sddx plan approve .sddx/specs/<goal-id>.md
```

## `sddx verify` fails its RED half

**Cause:** the oracle passed on the task's base commit with only the task's
test files applied. The tests do not catch the change, so they prove nothing
about it.

**Fix:** strengthen the test until it fails without the implementation. Do not
weaken the oracle: `verify` compares it with the approved spec and refuses a
task whose oracle or scope was edited. Changing either means revising the spec
and approving it again. [Verification](../reference/verification.md) covers
every check `verify` makes.

## `sddx verify` refuses the change itself

**Cause:** the task changed a file under `.sddx/`, which only the CLI writes,
or an implementation file outside the task's `scope`.

**Fix:** undo the out-of-scope change, or revise the spec so the scope covers
it and approve it again.

## The strict gate blocked a write

You'll see:

> sddx strict gate: blocked write to `<path>`; task `<id>` has no recorded
> failing test yet (rule: implementation path).

**Cause:** the repository uses the `strict` profile, and the task has no
recorded failing test run yet. This only happens under `"profile": "strict"`.

**Fix:** write the failing test and run it, so the recorder sees the failure.
For a runner the recorder does not recognize, record it by hand with
`sddx task phase <id> RED --test-exit 1`. For a file that genuinely cannot be
test-driven, such as generated code, `sddx task allow <id> <path>`. The
exemption is listed in the receipt. Details: [Hooks](../reference/hooks.md).

## A task keeps failing

**Cause:** the same failure, over and over. `sddx board` flags the task as
stuck once identical failures reach `stuck_threshold`.

**Fix:** the debug skill reproduces the failure with the oracle and tests one
hypothesis at a time. If the task cannot be done as specified, abandon it:

```sh
sddx task abandon <id> --reason "<why>"
```

Dependent tasks are then skipped, or the goal halts if a dependent says
`on_dependency_failure: block`.

## `review record` says the tree changed

**Cause:** someone edited the worktree after `verify` proved it, so the review
would not cover the proven code. The task went back to `IN_PROGRESS`.

**Fix:** run `sddx verify <id>` again, then review again.

## A review passed but the merge did not happen

You'll see `integration failed: ...`, with the task `DONE` and committed on its
`sddx/<id>` branch and the run branch unchanged.

**Fix:** merge it by hand with the command the message prints, usually
`git merge --no-ff sddx/<id>` on the run branch.

## Orphan worktrees under `.sddx-worktrees/`

**Cause:** interrupted tasks leave worktrees behind.

**Fix:** `sddx sweep` removes worktrees whose tasks are finished. It never
touches one with uncommitted changes, and never a proof worktree whose
`verify` is still running. For one task, `sddx cleanup <id>` removes its
worktree once the task is `DONE` or `ABANDONED`.

## `sddx audit` failed

**Cause:** a finding: the chain is broken, a receipt was edited or deleted, or
a receipt was never committed.

**Fix:** every finding and its remediation is in
[the receipts schema](../reference/receipts-schema.md#findings-and-remediation).
The short version: restore the receipt's committed bytes from git history.

## Worktrees are unavailable

You'll see `worktree unavailable: git cannot create worktrees for this
repository.`

**Cause:** a worktree per task is a hard precondition, not a preference. There
is no fallback to weaker isolation, so nothing was created.

**Fix:** use a checkout where `git worktree list` succeeds. If a task's `scope`
reaches into a submodule, narrow it so it does not.

## The session will not stop

**Cause:** the task this session is working on is `IN_PROGRESS` without a
proof. The stop gate does not accept a claim of "done".

**Fix:** finish it with `sddx verify <id>`, or give it up with
`sddx task abandon <id> --reason "<why>"`. A task at its iteration limit or
flagged stuck lets the session stop with a note instead.
