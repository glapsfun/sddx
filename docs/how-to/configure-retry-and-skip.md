# Configure retry and skip/block policy

Two keys in a task's `sddx` block decide what happens when a task cannot
finish. `retry` bounds re-attempts of that task; `on_dependency_failure` decides
what its dependents do once it is given up for good. A runnable walkthrough of
both is [examples/04-retry-and-skip](../../examples/04-retry-and-skip/).

## Retry: bounded re-attempts

```sddx
oracle:
  type: command
  run: bun test tests/import.test.ts
  expect: exit 0
retry:
  max_attempts: 2
  workspace: fresh
```

Giving up on a started task is one command:

```sh
sddx task abandon <id> --reason "<why>"
```

While attempts remain, it does not abandon: the task goes back to `PLANNED`
with its attempt count raised, and the command prints
`<id> retry <n>/<max>: back to PLANNED`. Only once attempts are used up does the
task become `ABANDONED`. Abandoning a task that is still `PLANNED` uses no
attempt: nothing was tried.

- `workspace: fresh` (the default) discards the worktree and branch, so the
  next `sddx task start` forks a clean one from the run branch.
- `workspace: reuse` keeps the worktree as it is, mistakes and all.

`max_attempts` defaults to 1. A `DONE` task is never reopened: its receipt is
immutable.

## on_dependency_failure: skip or block

Set on the dependent task:

```sddx
oracle:
  type: command
  run: bun test tests/report.test.ts
  expect: exit 0
depends_on: import
on_dependency_failure: block
```

When a parent ends `ABANDONED`:

- **`skip`** (the default): the dependent, and anything depending on it, is
  abandoned as skipped, and the rest of the goal keeps going. The run report
  lists it as skipped and names the parent that failed.
- **`block`**: the whole goal halts. `sddx task start` refuses every remaining
  task, naming the abandoned parent, and the run report lists them as blocked.

Check either with:

```sh
sddx run report --goal <goal-id>
sddx board
```
