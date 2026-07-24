# Configure retry and skip/block policy

Two independent spec fields govern what happens when a task can't finish:
`retry` bounds automatic re-attempts of *that task itself*; `on_dependency_failure`
decides what a *dependent* does when a named parent never recovers. A full
runnable walkthrough of both is
[examples/04-retry-and-skip](../../examples/04-retry-and-skip/).

## Retry: bounded re-attempts before ABANDONED

```yaml
retry:
  max_attempts: 2 # default 1 — today's single-attempt behavior
  workspace: fresh # fresh (default) | reuse
```

`sddx task phase <id> ABANDONED` doesn't always abandon: while
`attempt_count < max_attempts`, it resets the task to `PLAN` instead
(`attempt_count` increments, `iterations` and `evidence` clear, `stuck`
clears) — printing `retry <n>/<max_attempts> → phase=PLAN`. Only once
attempts are exhausted does the task actually become `ABANDONED`. `workspace:
fresh` discards and re-forks the worktree/branch from the same base SHA
before the next attempt; `reuse` leaves the existing workspace as-is, mistakes
and all. Retry never reopens an already-`DONE` task — a receipt is immutable
once written.

If a task with a retried-and-already-materialized dependent gets its base
commit superseded (a later retry lands a different commit than the one a
dependent already forked from), sddx discards and re-materializes that
dependent — and, recursively, anything materialized against *it* — from the
new commit. Never a rebase.

## on_dependency_failure: skip vs. block

```yaml
on_dependency_failure: block # default is skip
```

Governs a dependent's reaction once its named parent goes `ABANDONED` (for
good — retries exhausted, or no `retry` at all):

- **`skip`** (default) — the dependent (and, transitively, anything that
  depends on *it*) shows **Skipped** on the board; the rest of the goal keeps
  running.
- **`block`** — the dependent shows **Blocked** and escalates, same as it
  would while simply waiting on an unfinished parent.

Both are read straight off the board (`sddx board`) — no separate command
needed to check status; **Skipped** and **Blocked** are derived at read time
from the task files, never a persisted phase.
