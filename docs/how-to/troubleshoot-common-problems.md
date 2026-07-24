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
- the plugin isn't actually enabled (check `claude plugin list`);
- you're on a **skills-only install** — copied `skills/` directories load the
  workflows, but hooks (the TDD gate, recorder, stop gate) only ship with the
  full plugin. See [install-sddx.md](install-sddx.md#skills-only-mode).

**Fix:** run inside a git repo with the full plugin installed; verify per
[install-sddx.md](install-sddx.md#verifying-the-install).

## Worktree mode downgraded to branch mode

You'll see `submodules detected → branch mode` (or
`git worktree unavailable → branch mode`) from `task create`.

**Cause:** worktrees crossing submodule boundaries are unsafe, so `auto`
falls back to a sequential `sddx/<id>` branch. **This is expected behavior**,
not an error — the task runs the same loop, just not in parallel isolation.

## The Stop hook refuses to end the session

**Cause:** the active task has no verified receipt — the stop gate refuses to
conclude on a model claim of "done".

**Fix:** finish honestly: `sddx task phase <id> VERIFY` then
`sddx verify <id>`. If the task is genuinely being given up, say so:
`sddx task phase <id> ABANDONED` — an abandoned task no longer holds the
gate.
