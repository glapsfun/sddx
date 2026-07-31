# Troubleshooting

The most common surprises, what they mean, and the fix. Most of them are the
gates working as designed — sddx is deliberately strict, and every refusal
says why.

## "The gate blocked my write"

You'll see:

```
sddx TDD gate: blocked write to <path> — task <id> is in RED (rule: implementation path).
Before GREEN, only test files may change. ...
```

**Cause:** the task is pre-GREEN (PLAN or RED) and the target path classified
as implementation. This is the TDD gate doing its one job.

**Fix:** write the failing test first, run it so the failure is recorded, and
the gate lifts at GREEN. For a file that genuinely cannot be test-driven
(generated code, vendored assets): `sddx task allow <id> <path>` — the
exemption is audited in the receipt. Details: [../reference/hooks.md](../reference/hooks.md).

## Task stuck in RED

**Cause:** the recorder never observed a passing test run. It only reacts to
Bash test-runner invocations whose command matches the test globs — running
tests through some other mechanism (IDE runner, a wrapper script it can't
recognize) records nothing.

**Fix:** run the suite via a plain Bash command (e.g. `bun test tests/…`) so
the exit code is observed. By hand:
`sddx task phase <id> GREEN --test-exit 0` — but the transition is rejected
unless the evidence is real ([../reference/cli.md](../reference/cli.md#sddx-task-phase)).

## Orphan worktrees under `.sddx-worktrees/`

**Cause:** interrupted tasks leave worktrees behind.

**Fix:** `sddx sweep` removes the ones whose tasks are verified DONE; it is
lock-guarded and never touches a worktree with uncommitted changes — those are
flagged on the board instead. For a single stubborn task,
`sddx cleanup <id>` (it refuses dirty worktrees and unmerged branches, each
with a printed reason).

## `sddx audit` failed

**Cause:** a finding — the chain is broken, a receipt was edited or deleted,
or a receipt was never committed.

**Fix:** every finding and its remediation is listed in
[../reference/receipts-schema.md](../reference/receipts-schema.md#findings-and-remediation). The
short version: restore the receipt's committed bytes from git history; if the
proof is truly gone, re-run `sddx verify` for that task.

## Hooks aren't firing

**Cause:** one of —

- the session started outside a git repository (there is no `.sddx/` to
  bootstrap);
- the repository was never initialized (`sddx init --adapter claude`);
- the adapter's entries are missing from `.claude/settings.json`, or a
  generated file drifted — `sddx doctor` reports both;
- the repository gitignores `.claude/`, so the hooks exist on the machine that
  ran `init` and nowhere else. `sddx doctor` warns about this specifically.

**Fix:** run `sddx doctor` and follow the remediation it prints; verify per
[install-sddx.md](install-sddx.md#verifying-the-install).

## A run is refused because worktrees are unavailable

You'll see `worktree unavailable: git cannot create worktrees for this
repository. No run was started.` or `unsupported layout: task "<alias>"
declares scope <glob>, which reaches the submodule <path>.`

**Cause:** worktree isolation is a hard precondition, not a preference. There
is no branch-mode fallback to downgrade into — a failed precondition refuses
the run loudly rather than silently moving your work into weaker isolation you
did not ask for. Nothing was created.

**Fix:** for the submodule case, declare a narrower `scope` that does not reach
into the submodule — the check is scope-scoped, so a vendored submodule no task
touches is not a reason to refuse. For the worktree-unavailable case, use a
checkout where `git worktree list` succeeds. Upgrading from 3.x and expecting
the old automatic downgrade? See
[migrate-to-v4.md](migrate-to-v4.md#repositories-that-only-worked-in-branch-mode).

## The Stop hook refuses to end the session

**Cause:** the active task has no verified receipt — the stop gate refuses to
conclude on a model claim of "done".

**Fix:** finish honestly: `sddx task phase <id> VERIFY` then
`sddx verify <id>`. If the task is genuinely being given up, say so:
`sddx task phase <id> ABANDONED` — an abandoned task no longer holds the
gate.
