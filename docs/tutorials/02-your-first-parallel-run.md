# Your first parallel run

A goal with several tasks runs them side by side whenever their scopes allow.
This tutorial plans one with two independent tasks and a third that needs
both, and shows how sddx keeps them apart until each is proven. The same goal
driven by hand from the CLI is the scaffold at
[examples/02-parallel-run](../../examples/02-parallel-run/).

## The plan

After brainstorming, the plan skill writes three tasks:

````markdown
## Tasks

### g-greet greet function

```sddx
oracle:
  type: command
  run: bun test tests/greet.test.ts
  expect: exit 0
scope: [src/greet.ts, tests/greet.test.ts]
```

### g-polite polite suffix

```sddx
oracle:
  type: command
  run: bun test tests/polite.test.ts
  expect: exit 0
scope: [src/polite.ts, tests/polite.test.ts]
```

### g-both polite greeting

```sddx
oracle:
  type: command
  run: bun test tests/both.test.ts
  expect: exit 0
scope: [src/both.ts, tests/both.test.ts]
depends_on: [g-greet, g-polite]
```
````

`g-greet` and `g-polite` have no dependencies, so they can run at the same
time, and `sddx plan check` requires their scopes to be disjoint. Two tasks
that could write the same file cannot both be in flight; if they must touch
one file, order them with `depends_on`
([Model DAG dependencies](../how-to/model-dag-dependencies.md)).

## Why worktrees, not branches

Each started task gets its own worktree at `.sddx-worktrees/<id>` on branch
`sddx/<id>`, forked from the goal's run branch. Two tasks in one checkout
would compound: one task's unfinished edits would sit under the other's
tests. In separate worktrees, each task's edits, tests and proof stay apart
while work is in progress.

The **run branch**, `sddx/run-<goal-id>`, collects each task once its review
passes. It exists before any task starts, so the combined result can be
reviewed at any point. Your own branch is never touched.

## Running the roots in parallel

The execute skill asks which tasks are ready and starts them:

```sh
sddx task ready --goal 2026-10-27-greeting
sddx task start g-greet
sddx task start g-polite
```

Then it dispatches one worker subagent per task, both at once. Each works only
in its own worktree and ends with `sddx verify <id>`. Each then gets its own
critic review, and a pass merges that task into the run branch.

## The fan-in

`g-both` stays `PLANNED` until both of its dependencies are `DONE`. Then
`sddx task ready` lists it, and its worktree forks from the run branch, which by
now holds both roots' merged work. If either root is abandoned instead,
`g-both` is skipped and the rest of the goal finishes, or the goal halts if the
task says `on_dependency_failure: block`
([Configure retry and skip/block](../how-to/configure-retry-and-skip.md)).

## Watching progress

```sh
sddx board
sddx run report --goal 2026-10-27-greeting
```

`sddx board` writes `.sddx/BOARD.md`, a table of every task's state and
receipt across the main checkout and every worktree, and flags a task that
keeps failing the same way. The run report shows what has merged so far.

## Next

When the work has a real order, see
[Model DAG dependencies](../how-to/model-dag-dependencies.md). To land the
result, see [Ship a goal as a PR](../how-to/ship-a-goal-as-a-pr.md).
